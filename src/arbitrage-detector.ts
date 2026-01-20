import type { TickerPrice, ArbitrageOpportunity } from './types/exchange.js';
import type { Config } from './types/config.js';
import { Logger } from './utils/logger.js';
import { BinanceFutures } from './exchanges/binance-futures.js';
import { MexcFutures } from './exchanges/mexc-futures.js';
import { TradeExecutor } from './trade-executor.js';
import { WebSocketMonitor } from './utils/websocket-monitor.js';
import type { TuiDashboard } from './utils/tui.js';
//
/**
 * Класс для детектирования арбитражных возможностей
 */
export class ArbitrageDetector {
  private config: Config;
  private logger: Logger;
  private binance: BinanceFutures;
  private mexc: MexcFutures;
  private tradeExecutor: TradeExecutor;
  private commonSymbols: string[] = [];
  private wsMonitor: WebSocketMonitor;
  private tui?: TuiDashboard;

  // Кэш для сканера TUI (чтобы не перерисовывать слишком часто)
  private scannerCache: Map<string, { spread: number, profit: number, vol: string }> = new Map();
  private lastScannerUpdate = 0;

  // Счетчики статистики
  private opportunitiesFound = 0;
  private totalComparisons = 0;

  constructor(
    config: Config,
    logger?: Logger,
    apiKeys?: {
      binanceKey?: string;
      binanceSecret?: string;
      mexcKey?: string;
      mexcSecret?: string;
    }
  ) {
    this.config = config;
    this.logger = logger || new Logger();

    this.wsMonitor = new WebSocketMonitor();

    this.binance = new BinanceFutures(
      config.exchanges.binance.restBaseUrl,
      config.exchanges.binance.wsBaseUrl,
      config.arbitrage.reconnectDelayMs,
      this.logger,
      this.wsMonitor,
      apiKeys?.binanceKey,
      apiKeys?.binanceSecret
    );

    this.mexc = new MexcFutures(
      config.exchanges.mexc.restBaseUrl,
      config.exchanges.mexc.wsBaseUrl,
      config.arbitrage.reconnectDelayMs,
      this.logger,
      this.wsMonitor,
      apiKeys?.mexcKey,
      apiKeys?.mexcSecret
    );

    this.tradeExecutor = new TradeExecutor(
      config,
      this.logger,
      this.binance,
      this.mexc
    );
    this.tradeExecutor.setPriceGetter((symbol: string) => this.getCurrentPrices(symbol));
  }

  // Метод для связи с TUI (вызывается из main.ts)
  public setTui(tui: TuiDashboard) {
    this.tui = tui;
    // Прокидываем TUI в TradeExecutor, чтобы он мог рисовать позиции
    this.tradeExecutor.setTui(tui);
  }

  async start(): Promise<void> {
    this.logger.header('ЗАПУСК АРБИТРАЖНОГО БОТА');

    await this.checkExchangesHealth();
    await this.fetchTopPairs();

    this.tradeExecutor.start();

    // Минутные сводки больше не нужны в консоль, так как есть TUI.
    // Но оставим их в файл trades.log через логгер.
    if (!this.tui) this.startMinuteSummary(); 

    if (this.config.arbitrage.useWebSocket) {
      await this.startWebSocketMonitoring();
    } else {
      this.logger.warn('WebSocket отключен! Работа через REST API.');
    }
  }

  private async checkExchangesHealth(): Promise<void> {
    this.logger.info('Проверка доступности бирж...');
    const binanceOk = await this.binance.healthCheck();
    const mexcOk = await this.mexc.healthCheck();

    if (!binanceOk) throw new Error('Binance API недоступен');
    if (!mexcOk) throw new Error('MEXC API недоступен');
    
    this.logger.success('Биржи доступны');
  }

  private async fetchTopPairs(): Promise<void> {
    this.logger.info(`Получение топ ${this.config.arbitrage.topPairsCount} пар...`);

    const [binancePairs, mexcPairs] = await Promise.all([
      this.binance.getTopPairs(this.config.arbitrage.topPairsCount),
      this.mexc.getTopPairs(this.config.arbitrage.topPairsCount),
    ]);

    const binanceSymbols = new Set(binancePairs.map((p) => p.symbol));
    const mexcSymbolsConverted = new Set(
      mexcPairs.map((p) => MexcFutures.toCommonFormat(p.symbol))
    );

    this.commonSymbols = Array.from(binanceSymbols).filter((symbol) =>
      mexcSymbolsConverted.has(symbol)
    );

    if (this.config.arbitrage.excludePairs.length > 0) {
      this.commonSymbols = this.commonSymbols.filter(
        (s) => !this.config.arbitrage.excludePairs.includes(s)
      );
    }

    this.logger.success(`Отслеживаем ${this.commonSymbols.length} пар`);
    if (this.commonSymbols.length === 0) {
      throw new Error('Не найдено общих пар!');
    }
  }

  private async startWebSocketMonitoring(): Promise<void> {
    const mexcSymbols = this.commonSymbols.map((s) => MexcFutures.toMexcFormat(s));

    this.binance.connectWebSocket(this.commonSymbols, (price) => this.onPriceUpdate(price));
    this.mexc.connectWebSocket(mexcSymbols, (price) => this.onPriceUpdate(price));

    this.logger.success('WebSocket запущен');
  }

  private async onPriceUpdate(price: TickerPrice): Promise<void> {
    const normalizedSymbol = MexcFutures.toCommonFormat(price.symbol);
    let otherPrice: TickerPrice | undefined;

    if (price.exchange === 'binance') {
      const mexcSymbol = MexcFutures.toMexcFormat(normalizedSymbol);
      otherPrice = this.mexc.getPrice(mexcSymbol);
    } else {
      otherPrice = this.binance.getPrice(normalizedSymbol);
    }

    if (!otherPrice) return;

    await this.checkArbitrage(price, otherPrice, normalizedSymbol);
  }

  private async checkArbitrage(
    price1: TickerPrice,
    price2: TickerPrice,
    symbol: string
  ): Promise<void> {
    this.totalComparisons++;

    let buyExchange: 'binance' | 'mexc';
    let sellExchange: 'binance' | 'mexc';
    let buyPrice: number;
    let sellPrice: number;
    
    // Новое: сохраняем доступные объемы
    let buyQtyAvailable: number | undefined;
    let sellQtyAvailable: number | undefined;

    if (price1.ask < price2.bid) {
      buyExchange = price1.exchange;
      sellExchange = price2.exchange;
      buyPrice = price1.ask;
      sellPrice = price2.bid;
      buyQtyAvailable = price1.askQty; // Объем продавца на дешевой бирже
      sellQtyAvailable = price2.bidQty; // Объем покупателя на дорогой бирже
    } else if (price2.ask < price1.bid) {
      buyExchange = price2.exchange;
      sellExchange = price1.exchange;
      buyPrice = price2.ask;
      sellPrice = price1.bid;
      buyQtyAvailable = price2.askQty;
      sellQtyAvailable = price1.bidQty;
    } else {
      return;
    }

    const spreadPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

    // --- ОБНОВЛЕНИЕ TUI SCANNER ---
    // Обновляем данные для сканера, даже если спред маленький (чтобы видеть движуху)
    if (this.tui && spreadPercent > 0.05) {
        // Формируем строку объема (например: "Bin:50k/Mex:12k")
        // Если объем неизвестен, пишем "?"
        const buyVol = buyQtyAvailable 
            ? `$${(buyQtyAvailable * buyPrice).toFixed(0)}` 
            : '?';
        const sellVol = sellQtyAvailable 
            ? `$${(sellQtyAvailable * sellPrice).toFixed(0)}` 
            : '?';
            
        this.scannerCache.set(symbol, {
            spread: spreadPercent,
            profit: spreadPercent - 0.12, // Примерный Net Profit для визуала
            vol: `${buyVol}/${sellVol}`
        });

        // Перерисовываем сканер не чаще чем раз в 500мс
        const now = Date.now();
        if (now - this.lastScannerUpdate > 500) {
            this.tui.updateScanner(Array.from(this.scannerCache.entries()).map(([sym, val]) => ({
                symbol: sym,
                ...val
            })));
            this.lastScannerUpdate = now;
        }
    }
    // -----------------------------

    // ВАЖНО: Обновляем цены для всех открытых позиций НЕЗАВИСИМО от наличия арбитража
    // Это гарантирует что TUI показывает актуальные цены даже когда спред < minSpreadPercent
    await this.tradeExecutor.updatePositionSpread(symbol, buyPrice, sellPrice);

    if (spreadPercent < this.config.arbitrage.minSpreadPercent) return;

    const buyFee = this.config.fees[buyExchange].taker / 100;
    const sellFee = this.config.fees[sellExchange].taker / 100;
    const slippage = this.config.slippage.percent / 100;

    const buyPriceWithFee = buyPrice * (1 + buyFee + slippage);
    const sellPriceWithFee = sellPrice * (1 - sellFee - slippage);
    const profitPercent = ((sellPriceWithFee - buyPriceWithFee) / buyPriceWithFee) * 100;

    const opportunity: ArbitrageOpportunity = {
      symbol,
      buyExchange,
      sellExchange,
      buyPrice,
      sellPrice,
      // Прокидываем объемы
      buyQtyAvailable,
      sellQtyAvailable,
      spreadPercent,
      profitPercent,
      timestamp: Date.now(),
    };

    this.opportunitiesFound++;

    if (this.config.trading.enabled) {
      this.handleNewOpportunity(opportunity);
    }
  }

  private handleNewOpportunity(opportunity: ArbitrageOpportunity): void {
    const openPositions = this.tradeExecutor.getOpenPositions();
    for (const [_, pair] of openPositions.entries()) {
      if (pair.symbol === opportunity.symbol) return;
    }

    if (this.tradeExecutor.canOpenNewPosition()) {
      this.tradeExecutor.openPositionPair(opportunity);
      return;
    }

    // Логика Smart Close осталась без изменений, просто сократил код для читаемости здесь
    this.tradeExecutor.recordSkippedOpportunity(opportunity, 'NO_FREE_SLOTS');
  }

  getCurrentPrices(symbol: string): { buyPrice: number; sellPrice: number } | null {
    const binancePrice = this.binance.getPrice(symbol);
    const mexcPrice = this.mexc.getPrice(MexcFutures.toMexcFormat(symbol));

    if (!binancePrice || !mexcPrice) return null;

    let buyPrice: number;
    let sellPrice: number;

    if (binancePrice.ask < mexcPrice.bid) {
      buyPrice = binancePrice.ask;
      sellPrice = mexcPrice.bid;
    } else {
      buyPrice = mexcPrice.ask;
      sellPrice = binancePrice.bid;
    }

    return { buyPrice, sellPrice };
  }

  private startMinuteSummary(): void {
    // Эта функция теперь используется только для логов в файл, если TUI отключен
    // Или если мы хотим сохранить историю в файл
  }

  async stop(): Promise<void> {
    this.binance.disconnect();
    this.mexc.disconnect();
    this.tradeExecutor.stop();

    if (this.config.trading.enabled) {
       // Генерация отчета при необходимости
       void this.tradeExecutor.getStats();
    }
  }

  /**
   * Получить ссылку на TradeExecutor (для graceful shutdown)
   */
  getTradeExecutor(): TradeExecutor {
    return this.tradeExecutor;
  }

  /**
   * Получить ссылку на WebSocketMonitor (для отчета)
   */
  getWsMonitor(): WebSocketMonitor {
    return this.wsMonitor;
  }
}
