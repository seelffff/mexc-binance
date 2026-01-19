import type {
  Position,
  PositionPair,
  ArbitrageOpportunity,
  SkippedOpportunity,
  CloseReason,
  PriceSnapshot,
} from './types/exchange.js';
import type { Config } from './types/config.js';
import { Logger } from './utils/logger.js';
import { CompactLogger } from './utils/compact-logger.js';
import { randomUUID } from 'crypto';
import type { TuiDashboard } from './utils/tui.js';

export class TradeExecutor {
  private config: Config;
  private logger: Logger;
  private compactLogger: CompactLogger;
  private tui?: TuiDashboard; // Ссылка на TUI

  private openPositions: Map<string, PositionPair> = new Map();
  private closedPositions: PositionPair[] = [];
  private skippedOpportunities: SkippedOpportunity[] = [];
  
  private checkInterval: NodeJS.Timeout | null = null;
  private priceHistoryInterval: NodeJS.Timeout | null = null;
  private getPricesFn?: (symbol: string) => { buyPrice: number; sellPrice: number } | null;
  
  private currentBalance: number;
  private initialBalance: number;

  private testStats = {
    totalTrades: 0,
    profitableTrades: 0,
    losingTrades: 0,
    totalProfit: 0,
    totalLoss: 0,
  };

  constructor(config: Config, logger?: Logger) {
    this.config = config;
    this.logger = logger || new Logger();
    this.compactLogger = new CompactLogger(config);
    this.initialBalance = config.trading.testBalanceUSD;
    this.currentBalance = config.trading.testBalanceUSD;
  }

  public setTui(tui: TuiDashboard) {
    this.tui = tui;
  }

  setPriceGetter(fn: (symbol: string) => { buyPrice: number; sellPrice: number } | null): void {
    this.getPricesFn = fn;
  }

  start(): void {
    if (!this.config.trading.enabled) return;

    // Обновляем TUI каждые 500мс для плавности отображения
    this.checkInterval = setInterval(() => {
      this.checkPositionTimeouts();
      // Обновляем TUI позиции
      if(this.tui) this.tui.updatePositions(Array.from(this.openPositions.values()));
    }, 500);

    // Запись истории цен каждые 5 секунд
    this.priceHistoryInterval = setInterval(() => {
      this.recordPriceHistory();
    }, 5000);
  }

  /**
   * Записывает текущие цены в историю для каждой открытой позиции
   */
  private recordPriceHistory(): void {
    if (!this.getPricesFn) return;

    for (const [_pairId, pair] of this.openPositions.entries()) {
      if (pair.status !== 'OPEN') continue;

      const prices = this.getPricesFn(pair.symbol);
      if (!prices) continue;

      // Определяем цены для каждой биржи
      const binancePrice = pair.longPosition.exchange === 'binance'
        ? prices.buyPrice
        : prices.sellPrice;
      const mexcPrice = pair.longPosition.exchange === 'mexc'
        ? prices.buyPrice
        : prices.sellPrice;

      const priceDiffPercent = Math.abs(binancePrice - mexcPrice) / Math.min(binancePrice, mexcPrice) * 100;
      const spreadPercent = ((prices.sellPrice - prices.buyPrice) / prices.buyPrice) * 100;

      const snapshot: PriceSnapshot = {
        timestamp: Date.now(),
        binancePrice,
        mexcPrice,
        priceDiffPercent,
        spreadPercent,
      };

      // Инициализируем массив если нужно
      if (!pair.priceHistory) {
        pair.priceHistory = [];
      }
      pair.priceHistory.push(snapshot);
    }
  }

  canOpenNewPosition(): boolean {
    if (!this.config.trading.enabled) return false;
    return this.openPositions.size < this.config.trading.maxOpenPositions;
  }

  // === СИМУЛЯЦИЯ ЦЕНЫ ИСПОЛНЕНИЯ (AVG ENTRY PRICE) ===
  private calculateExecutionPrice(
    requestedUsd: number,
    basePrice: number,
    availableQty: number | undefined
  ): { avgPrice: number, slippageCost: number, details: string } {
    
    // Если биржа не прислала объем (например MEXC иногда), берем "бесконечную" ликвидность
    // или дефолтное значение $10,000, чтобы не ломать логику.
    const realQty = availableQty !== undefined ? availableQty : (10000 / basePrice);
    
    // Объем в USD который реально есть в стакане по лучшей цене
    const realDepthUsd = realQty * basePrice;

    // Если ликвидности хватает с запасом
    if (realDepthUsd >= requestedUsd) {
        return { 
            avgPrice: basePrice, 
            slippageCost: 0, 
            details: 'Full Fill' 
        };
    }

    // Если не хватает:
    // Часть берем по basePrice, остаток по цене с проскальзыванием
    const filledReal = realDepthUsd;
    const filledSlippage = requestedUsd - realDepthUsd;
    
    // Цена штрафа: basePrice + Slippage%
    // (для покупки цена растет, для продажи падает, но мы тут считаем "худшую" цену)
    const penaltyPrice = basePrice * (1 + (this.config.slippage.percent / 100));

    // Средневзвешенная цена
    const avgPrice = ((filledReal * basePrice) + (filledSlippage * penaltyPrice)) / requestedUsd;
    
    // Потеря в долларах из-за отсутствия ликвидности
    const idealCost = requestedUsd / basePrice; // сколько бы купили монет в идеале
    const realCost = requestedUsd / avgPrice;   // сколько купили реально
    const slippageCost = (idealCost - realCost) * basePrice; // Потеря в монетах переведенная в USD

    return {
        avgPrice,
        slippageCost,
        details: `Partial: $${filledReal.toFixed(0)} @ Best, $${filledSlippage.toFixed(0)} @ Slip`
    };
  }
  // ===================================================

  async openPositionPair(opportunity: ArbitrageOpportunity): Promise<void> {
    const requiredCapital = this.config.trading.positionSizeUSD * 2;
    if (this.currentBalance < requiredCapital) {
      this.recordSkippedOpportunity(opportunity, "INSUFFICIENT_BALANCE");
      return;
    }

    // 1. Рассчитываем реальную цену входа для LONG (Покупка)
    // availableQty - это askQty (то что продают другие)
    const longExec = this.calculateExecutionPrice(
        this.config.trading.positionSizeUSD,
        opportunity.buyPrice,
        opportunity.buyQtyAvailable
    );

    // 2. Рассчитываем реальную цену входа для SHORT (Продажа)
    // availableQty - это bidQty (то что покупают другие)
    const shortExec = this.calculateExecutionPrice(
        this.config.trading.positionSizeUSD,
        opportunity.sellPrice,
        opportunity.sellQtyAvailable
    );

    // Если были проблемы с ликвидностью, пишем варнинг в лог
    if (longExec.slippageCost > 0 || shortExec.slippageCost > 0) {
        this.logger.warn(`Liquidity Hit on ${opportunity.symbol}: Long ${longExec.details}, Short ${shortExec.details}`);
    }

    const pairId = randomUUID();
    const now = Date.now();
    const timeoutAt = this.config.trading.positionTimeoutSeconds === 0
      ? Infinity
      : now + this.config.trading.positionTimeoutSeconds * 1000;

    const longPosition: Position = {
      id: randomUUID(),
      symbol: opportunity.symbol,
      exchange: opportunity.buyExchange,
      side: 'LONG',
      entryPrice: longExec.avgPrice, // ИСПОЛЬЗУЕМ AVG PRICE
      quantity: this.config.trading.positionSizeUSD / longExec.avgPrice,
      sizeUSD: this.config.trading.positionSizeUSD,
      leverage: this.config.trading.leverage,
      status: 'OPEN',
      openTime: now,
    };

    const shortPosition: Position = {
      id: randomUUID(),
      symbol: opportunity.symbol,
      exchange: opportunity.sellExchange,
      side: 'SHORT',
      entryPrice: shortExec.avgPrice, // ИСПОЛЬЗУЕМ AVG PRICE
      quantity: this.config.trading.positionSizeUSD / shortExec.avgPrice,
      sizeUSD: this.config.trading.positionSizeUSD,
      leverage: this.config.trading.leverage,
      status: 'OPEN',
      openTime: now,
    };

    // Определяем оригинальные цены для каждой биржи
    const originalBinancePrice = opportunity.buyExchange === 'binance'
      ? opportunity.buyPrice
      : opportunity.sellPrice;
    const originalMexcPrice = opportunity.buyExchange === 'mexc'
      ? opportunity.buyPrice
      : opportunity.sellPrice;

    const positionPair: PositionPair = {
      id: pairId,
      symbol: opportunity.symbol,
      longPosition,
      shortPosition,
      openSpread: opportunity.spreadPercent,
      expectedProfit: opportunity.profitPercent,
      status: 'OPEN',
      openTime: now,
      timeoutAt,
      originalBinancePrice,
      originalMexcPrice,
      priceDiffPercent: opportunity.spreadPercent, // Изначально равен спреду
    };

    this.openPositions.set(pairId, positionPair);
    this.currentBalance -= requiredCapital;

    // Пишем красивый лог
    this.logger.trade(`OPEN ${opportunity.symbol}: Spread ${opportunity.spreadPercent.toFixed(2)}%. Est. Profit: ${opportunity.profitPercent.toFixed(2)}%`);
    if (this.tui) {
      this.tui.log(`{green-fg}✓ Открыта позиция ${opportunity.symbol}: Binance @ ${originalBinancePrice.toFixed(4)}, MEXC @ ${originalMexcPrice.toFixed(4)}{/}`);
    }

    // Обновляем TUI
    if(this.tui) this.tui.updatePositions(Array.from(this.openPositions.values()));
  }

  updatePositionSpread(symbol: string, currentBuyPrice: number, currentSellPrice: number): void {
    for (const [pairId, pair] of this.openPositions.entries()) {
      if (pair.symbol === symbol && pair.status === 'OPEN') {
        const currentSpread = ((currentSellPrice - currentBuyPrice) / currentBuyPrice) * 100;
        pair.currentSpread = currentSpread;

        // Сохраняем текущие цены для TUI отображения
        // LONG - где купили дешевле, SHORT - где продали дороже
        if (pair.longPosition.exchange === 'binance') {
          pair.currentLongPrice = currentBuyPrice;
          pair.currentShortPrice = currentSellPrice;
        } else {
          pair.currentLongPrice = currentSellPrice;
          pair.currentShortPrice = currentBuyPrice;
        }

        // Расчет текущей разницы цен для сходимости (priceDiffPercent)
        const priceDiff = Math.abs(currentBuyPrice - currentSellPrice) / Math.min(currentBuyPrice, currentSellPrice) * 100;
        pair.priceDiffPercent = priceDiff;

        // Расчет текущего PnL (примерный) для отображения
        // (Реальный PnL считается при закрытии)
        const longPnl = ((pair.currentLongPrice - pair.longPosition.entryPrice) / pair.longPosition.entryPrice) * 100;
        const shortPnl = ((pair.shortPosition.entryPrice - pair.currentShortPrice) / pair.shortPosition.entryPrice) * 100;
        pair.actualProfit = (longPnl + shortPnl) / 2 - (0.12); // Вычитаем примерные комиссии (0.12%)

        // === НОВАЯ ЛОГИКА: Закрытие при сходимости ЦЕН (не спреда!) ===
        if (this.config.trading.closeOnSpreadConvergence) {
          // Проверяем, сошлись ли цены на двух биржах
          const priceConverged = this.checkPriceConvergence(currentBuyPrice, currentSellPrice);

          if (priceConverged) {
            this.logger.info(`Цены сошлись (${currentBuyPrice.toFixed(4)} / ${currentSellPrice.toFixed(4)}). Закрываем ${symbol}.`);
            if (this.tui) {
              this.tui.log(`{cyan-fg}⚠ Цены сошлись на ${symbol}! Разница: ${priceDiff.toFixed(3)}%. Закрываю позицию...{/}`);
            }
            this.closePositionPair(pairId, 'CONVERGENCE', currentBuyPrice, currentSellPrice);
          }
        }
      }
    }
  }

  /**
   * Проверяет, сошлись ли цены на двух биржах
   */
  private checkPriceConvergence(price1: number, price2: number): boolean {
    const priceDiffPercent = Math.abs(price1 - price2) / Math.min(price1, price2) * 100;
    return priceDiffPercent <= this.config.trading.priceConvergencePercent;
  }

  private closePositionPair(
    pairId: string,
    reason: CloseReason,
    currentBuyPrice: number,
    currentSellPrice: number
  ): void {
    const pair = this.openPositions.get(pairId);
    if (!pair) return;

    const now = Date.now();

    // Считаем PnL по ценам выхода
    // Тут тоже можно было бы применить Slippage на выход, но для упрощения пока берем Market Price
    // (можно докрутить ту же функцию calculateExecutionPrice для выхода)
    const longPnlPercent = ((currentBuyPrice - pair.longPosition.entryPrice) / pair.longPosition.entryPrice) * 100;
    const shortPnlPercent = ((pair.shortPosition.entryPrice - currentSellPrice) / pair.shortPosition.entryPrice) * 100;

    // Вычитаем комиссии (Taker Fee * 2)
    const fees = (this.config.fees.binance.taker + this.config.fees.mexc.taker) * 2; 
    
    const totalPnlPercent = ((longPnlPercent + shortPnlPercent) / 2) - fees;
    
    // PnL в долларах
    // Если Size=100$, то 1% = 1$. Формула: (Percent / 100) * (Size * 2)
    const totalPnlUSD = (totalPnlPercent / 100) * (this.config.trading.positionSizeUSD * 2);

    pair.status = reason === 'TIMEOUT' ? 'TIMEOUT_CLOSED' : 'CLOSED';
    pair.closeTime = now;
    pair.closeReason = reason;
    pair.actualProfit = totalPnlPercent;
    
    // Заполняем данные позиций
    pair.longPosition.exitPrice = currentBuyPrice;
    pair.longPosition.pnl = (longPnlPercent / 100) * this.config.trading.positionSizeUSD;
    pair.longPosition.pnlPercent = longPnlPercent;
    
    pair.shortPosition.exitPrice = currentSellPrice;
    pair.shortPosition.pnl = (shortPnlPercent / 100) * this.config.trading.positionSizeUSD;
    pair.shortPosition.pnlPercent = shortPnlPercent;

    this.openPositions.delete(pairId);
    this.closedPositions.push(pair);

    this.currentBalance += (this.config.trading.positionSizeUSD * 2) + totalPnlUSD;

    // Статистика
    this.testStats.totalTrades++;
    if (totalPnlUSD > 0) {
        this.testStats.profitableTrades++;
        this.testStats.totalProfit += totalPnlUSD;
    } else {
        this.testStats.losingTrades++;
        this.testStats.totalLoss += Math.abs(totalPnlUSD);
    }

    // Лог
    const color = totalPnlUSD >= 0 ? '{green-fg}' : '{red-fg}';
    this.logger.trade(`CLOSE ${pair.symbol}: PnL ${color}$${totalPnlUSD.toFixed(2)}{/} (${totalPnlPercent.toFixed(2)}%). Reason: ${reason}`);

    if(this.tui) this.tui.updatePositions(Array.from(this.openPositions.values()));
  }

  // ... остальные геттеры (getStats, stop, etc) без изменений ...
  getOpenPositions() { return this.openPositions; }
  getStats() { 
      return { 
          openPositions: this.openPositions.size, 
          closedPositions: this.closedPositions.length, 
          testStats: this.testStats,
          winRate: this.testStats.totalTrades > 0 ? (this.testStats.profitableTrades / this.testStats.totalTrades * 100) : 0,
          netProfit: this.testStats.totalProfit - this.testStats.totalLoss
      }; 
  }
  getSkippedOpportunities() { return this.skippedOpportunities; }
  getInitialBalance() { return this.initialBalance; }
  getCurrentBalance() { return this.currentBalance; }
  getClosedPositions() { return this.closedPositions; }
  getCompactLogger() { return this.compactLogger; } // Для совместимости

  recordSkippedOpportunity(_opp: ArbitrageOpportunity, _reason: unknown) {
      // Можно тоже писать в лог, если нужно
  }
  
  stop() {
      if (this.checkInterval) clearInterval(this.checkInterval);
      if (this.priceHistoryInterval) clearInterval(this.priceHistoryInterval);
  }

  /**
   * Принудительно закрыть все открытые позиции (для graceful shutdown)
   */
  forceCloseAllPositions(): void {
    const positions = Array.from(this.openPositions.entries());

    for (const [pairId, pair] of positions) {
      if (this.getPricesFn) {
        const prices = this.getPricesFn(pair.symbol);
        if (prices) {
          this.logger.warn(`FORCE CLOSE ${pair.symbol} по Ctrl+C`);
          this.closePositionPair(pairId, 'FORCE_SHUTDOWN', prices.buyPrice, prices.sellPrice);
        }
      }
    }
  }

  private checkPositionTimeouts() {
      // Логика таймаутов аналогична методу updatePositionSpread, вызывает closePositionPair
      const now = Date.now();
      for (const [pairId, pair] of this.openPositions.entries()) {
          if (now >= pair.timeoutAt) {
               // Получаем цены через геттер
               if (this.getPricesFn) {
                   const prices = this.getPricesFn(pair.symbol);
                   if (prices) {
                       this.closePositionPair(pairId, 'TIMEOUT', prices.buyPrice, prices.sellPrice);
                   }
               }
          }
      }
  }
}
