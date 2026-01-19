import WebSocket from 'ws';
import type { TickerPrice, TradingPair } from '../types/exchange.js';
import { Logger } from '../utils/logger.js';
import type { WebSocketMonitor } from '../utils/websocket-monitor.js';

/**
 * Интерфейс ответа MEXC ticker API
 */
interface MexcTickerResponse {
  success: boolean;
  code: number;
  data: Array<{
    symbol: string;
    lastPrice: number;
    bid1: number;
    ask1: number;
    volume24: number;
    amount24: number;
    holdVol: number;
    riseFallRate: number;
    timestamp: number;
  }>;
}

/**
 * Класс для работы с MEXC Futures API
 */
export class MexcFutures {
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

  async getTopPairs(limit = 50): Promise<TradingPair[]> {
    try {
      const url = `${this.restBaseUrl}/api/v1/contract/ticker`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`MEXC API error: ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as MexcTickerResponse;

      if (!json.success || !json.data) {
        throw new Error('MEXC API returned unsuccessful response');
      }

      const usdtPairs = json.data
        .filter((ticker) => ticker.symbol.endsWith('_USDT'))
        .sort((a, b) => b.amount24 - a.amount24)
        .slice(0, limit);

      return usdtPairs.map((ticker) => ({
        symbol: ticker.symbol,
        baseAsset: ticker.symbol.replace('_USDT', ''),
        quoteAsset: 'USDT',
        volume24h: ticker.amount24,
      }));
    } catch (error) {
      this.logger.error(
        `MEXC: Ошибка получения топ пар - ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  connectWebSocket(symbols: string[], onPriceUpdate?: (price: TickerPrice) => void): void {
    if (this.ws) {
      this.logger.warn('MEXC: WebSocket уже подключен');
      return;
    }

    this.logger.info(`MEXC: Подключение к WebSocket (${symbols.length} символов)...`);

    this.ws = new WebSocket(this.wsBaseUrl);

    this.ws.on('open', () => {
      this.logger.success(`MEXC: WebSocket подключен`);

      symbols.forEach((symbol) => {
        const subscribeMsg = {
          method: 'sub.ticker',
          param: {
            symbol: symbol,
          },
        };

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(subscribeMsg));
        }
      });

      this.logger.success(`MEXC: Подписка на ${symbols.length} пар отправлена`);
      this.startPingInterval();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());

        if (parsed.channel === 'push.ticker' && parsed.data) {
          const ticker = parsed.data;

          const price: TickerPrice = {
            symbol: ticker.symbol,
            price: parseFloat(ticker.lastPrice),
            bid: parseFloat(ticker.bid1),
            ask: parseFloat(ticker.ask1),
            // --- НОВОЕ: Пробуем парсить объемы (если они есть) ---
            // Внимание: Стандартный ticker стрим MEXC часто не шлет объемы (bid1Vol).
            // Если они undefined, TradeExecutor будет использовать дефолтное значение (например $10000).
            bidQty: ticker.bid1Vol ? parseFloat(ticker.bid1Vol) : undefined,
            askQty: ticker.ask1Vol ? parseFloat(ticker.ask1Vol) : undefined,
            // ----------------------------------------------------
            timestamp: ticker.timestamp || Date.now(),
            exchange: 'mexc',
          };

          this.priceCache.set(price.symbol, price);

          if (onPriceUpdate) {
            onPriceUpdate(price);
          }
        }
      } catch (error) {
        this.logger.error(
          `MEXC: Ошибка парсинга WS сообщения - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });

    this.ws.on('error', (error) => {
      this.logger.error(`MEXC: WebSocket ошибка - ${error.message}`);
      if (this.wsMonitor) {
        this.wsMonitor.recordDisconnect('mexc', `Error: ${error.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonText = reason.toString() || `Code: ${code}`;
      this.logger.warn(`MEXC: WebSocket отключен (${reasonText})`);

      if (this.wsMonitor) {
        this.wsMonitor.recordDisconnect('mexc', reasonText);
      }

      this.cleanup();

      this.logger.info(`MEXC: Переподключение через ${this.reconnectDelay}ms...`);
      setTimeout(() => {
        this.connectWebSocket(symbols, onPriceUpdate);
      }, this.reconnectDelay);
    });

    this.ws.on('open', () => {
      this.logger.success('MEXC: WebSocket подключен');
      if (this.wsMonitor) {
        this.wsMonitor.recordReconnect('mexc');
      }
    });

    this.ws.on('ping', () => {
      if (this.ws) {
        this.ws.pong();
      }
    });
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 15000);
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
      this.logger.info('MEXC: WebSocket отключен вручную');
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
      const url = `${this.restBaseUrl}/api/v1/contract/ping`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  static toCommonFormat(mexcSymbol: string): string {
    return mexcSymbol.replace('_', '');
  }

  static toMexcFormat(binanceSymbol: string): string {
    return binanceSymbol.replace('USDT', '_USDT');
  }
}
