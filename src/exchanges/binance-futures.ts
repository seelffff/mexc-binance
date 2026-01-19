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

  constructor(
    restBaseUrl: string,
    wsBaseUrl: string,
    reconnectDelay = 3000,
    logger?: Logger,
    wsMonitor?: WebSocketMonitor
  ) {
    this.restBaseUrl = restBaseUrl;
    this.wsBaseUrl = wsBaseUrl;
    this.reconnectDelay = reconnectDelay;
    this.logger = logger || new Logger();
    this.wsMonitor = wsMonitor || null;
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
}
