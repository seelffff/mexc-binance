import WebSocket from 'ws';
import type { TickerPrice, TradingPair, Ticker24h } from '../types/exchange.js';
import { Logger } from '../utils/logger.js';
import type { WebSocketMonitor } from '../utils/websocket-monitor.js';

/**
 * Класс для работы с Binance USDT-M Futures API
 * Документация: https://developers.binance.com/docs/derivatives/usds-margined-futures
 */
export class BinanceFutures {
  private restBaseUrl: string;
  private wsBaseUrl: string;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private priceCache: Map<string, TickerPrice> = new Map();
  private reconnectDelay: number;
  private pingInterval: NodeJS.Timeout | null = null;
  private wsMonitor: WebSocketMonitor | null = null;
  private apiKey?: string;
  private apiSecret?: string;

  constructor(
    restBaseUrl: string,
    wsBaseUrl: string,
    reconnectDelay = 3000,
    logger?: Logger,
    wsMonitor?: WebSocketMonitor,
    apiKey?: string,
    apiSecret?: string
  ) {
    this.restBaseUrl = restBaseUrl;
    this.wsBaseUrl = wsBaseUrl;
    this.reconnectDelay = reconnectDelay;
    this.logger = logger || new Logger();
    this.wsMonitor = wsMonitor || null;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  /**
   * Получить топ N торговых пар по объему через REST API
   * Endpoint: GET /fapi/v1/ticker/24hr
   */
  async getTopPairs(limit = 50): Promise<TradingPair[]> {
    try {
      const url = `${this.restBaseUrl}/fapi/v1/ticker/24hr`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as Ticker24h[];

      // Фильтруем только USDT пары и сортируем по объему в USDT
      const usdtPairs = data
        .filter((ticker) => ticker.symbol.endsWith('USDT'))
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, limit);

      return usdtPairs.map((ticker) => ({
        symbol: ticker.symbol,
        baseAsset: ticker.symbol.replace('USDT', ''),
        quoteAsset: 'USDT',
        volume24h: ticker.quoteVolume,
      }));
    } catch (error) {
      this.logger.error(
        `Binance: Ошибка получения топ пар - ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Подключиться к WebSocket и подписаться на bookTicker для списка символов
   * Stream: <symbol>@bookTicker
   */
  connectWebSocket(symbols: string[], onPriceUpdate?: (price: TickerPrice) => void): void {
    if (this.ws) {
      this.logger.warn('Binance: WebSocket уже подключен');
      return;
    }

    // Создаем combined stream URL
    const streams = symbols.map((s) => `${s.toLowerCase()}@bookTicker`).join('/');
    const wsUrl = `${this.wsBaseUrl}/stream?streams=${streams}`;

    this.logger.info(`Binance: Подключение к WebSocket (${symbols.length} символов)...`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.logger.success(`Binance: WebSocket подключен (${symbols.length} пар)`);
      this.startPingInterval();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());

        // Binance combined stream format: { stream: "btcusdt@bookTicker", data: {...} }
        if (parsed.data) {
          const ticker = parsed.data;

          const price: TickerPrice = {
            symbol: ticker.s, // Symbol
            price: parseFloat(ticker.c || ticker.b), // Используем best bid как цену, если нет последней
            bid: parseFloat(ticker.b), // Best bid price
            ask: parseFloat(ticker.a), // Best ask price
            // --- НОВОЕ: Парсим объемы ---
            bidQty: parseFloat(ticker.B), // Best bid quantity
            askQty: parseFloat(ticker.A), // Best ask quantity
            // ---------------------------
            timestamp: ticker.T || Date.now(), // Transaction time
            exchange: 'binance',
          };

          // Обновляем кэш
          this.priceCache.set(price.symbol, price);

          // Вызываем callback если передан
          if (onPriceUpdate) {
            onPriceUpdate(price);
          }
        }
      } catch (error) {
        this.logger.error(
          `Binance: Ошибка парсинга WS сообщения - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });

    this.ws.on('error', (error) => {
      this.logger.error(`Binance: WebSocket ошибка - ${error.message}`);
      if (this.wsMonitor) {
        this.wsMonitor.recordDisconnect('binance', `Error: ${error.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonText = reason.toString() || `Code: ${code}`;
      this.logger.warn(`Binance: WebSocket отключен (${reasonText})`);

      if (this.wsMonitor) {
        this.wsMonitor.recordDisconnect('binance', reasonText);
      }

      this.cleanup();

      // Автопереподключение
      this.logger.info(`Binance: Переподключение через ${this.reconnectDelay}ms...`);
      setTimeout(() => {
        this.connectWebSocket(symbols, onPriceUpdate);
      }, this.reconnectDelay);
    });

    this.ws.on('open', () => {
      this.logger.success('Binance: WebSocket подключен');
      if (this.wsMonitor) {
        this.wsMonitor.recordReconnect('binance');
      }
    });
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.pong();
      }
    }, 30000);
  }

  getPrice(symbol: string): TickerPrice | undefined {
    return this.priceCache.get(symbol);
  }

  getAllPrices(): Map<string, TickerPrice> {
    return this.priceCache;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.cleanup();
      this.logger.info('Binance: WebSocket отключен вручную');
    }
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.ws = null;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = `${this.restBaseUrl}/fapi/v1/ping`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Создать рыночный ордер на Binance Futures
   * @param symbol Символ (например, BTCUSDT)
   * @param side BUY или SELL
   * @param quantity Количество в базовой валюте
   * @param reduceOnly Только для закрытия позиции (default: false)
   */
  async createMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    reduceOnly = false
  ): Promise<any> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Binance: API ключи не установлены');
    }

    const crypto = await import('crypto');
    const timestamp = Date.now();

    // ВАЖНО: Параметры НЕ нужно сортировать! (согласно официальному примеру Binance)
    // Порядок параметров важен - сохраняем порядок вставки
    const params: string[] = [];
    params.push(`symbol=${symbol}`);
    params.push(`side=${side}`);
    params.push(`type=MARKET`);
    params.push(`quantity=${quantity.toString()}`);

    // Добавляем reduceOnly только если true (для закрытия позиций)
    if (reduceOnly) {
      params.push('reduceOnly=true');
    }

    params.push(`timestamp=${timestamp}`);
    params.push('recvWindow=5000');  // 5 секунд окно для синхронизации времени

    // Создаем query string БЕЗ сортировки
    const queryString = params.join('&');

    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');

    // ВАЖНО: Для Binance Futures все параметры идут в URL query string, даже для POST!
    const url = `${this.restBaseUrl}/fapi/v1/order?${queryString}&signature=${signature}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Binance order failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      this.logger.success(`Binance: Ордер создан - ${side} ${quantity} ${symbol}`);
      return result;
    } catch (error) {
      this.logger.error(`Binance: Ошибка создания ордера - ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Установить leverage для символа
   */
  async setLeverage(symbol: string, leverage: number): Promise<any> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Binance: API ключи не установлены');
    }

    const crypto = await import('crypto');
    const timestamp = Date.now();

    // ВАЖНО: Параметры НЕ нужно сортировать! (согласно официальному примеру Binance)
    const params: string[] = [];
    params.push(`symbol=${symbol}`);
    params.push(`leverage=${leverage}`);
    params.push(`timestamp=${timestamp}`);
    params.push('recvWindow=5000');  // 5 секунд окно для синхронизации времени

    // Создаем query string БЕЗ сортировки
    const queryString = params.join('&');

    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');

    // ВАЖНО: Для Binance Futures все параметры идут в URL query string, даже для POST!
    const url = `${this.restBaseUrl}/fapi/v1/leverage?${queryString}&signature=${signature}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Binance leverage failed: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.error(`Binance: Ошибка установки leverage - ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Получить текущий баланс
   */
  async getBalance(): Promise<number> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Binance: API ключи не установлены');
    }

    const crypto = await import('crypto');
    const timestamp = Date.now();

    const queryString = `timestamp=${timestamp}&recvWindow=5000`;

    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');

    const url = `${this.restBaseUrl}/fapi/v2/balance?${queryString}&signature=${signature}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Binance balance failed: ${response.status} - ${errorText}`);
      }

      const balances = await response.json();
      const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
      return usdtBalance ? parseFloat(usdtBalance.availableBalance) : 0;
    } catch (error) {
      this.logger.error(`Binance: Ошибка получения баланса - ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
