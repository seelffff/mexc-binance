import type { PositionPair } from '../types/exchange.js';
import type { Config } from '../types/config.js';

/**
 * Причины пропуска сигнала
 */
export type SkipReasonType =
  | 'INSUFFICIENT_BALANCE'
  | 'POSITION_NOT_PROFITABLE'
  | 'NO_FREE_SLOTS'
  | 'SYMBOL_ALREADY_OPEN'
  | 'PROFIT_BELOW_THRESHOLD'
  | 'SPREAD_CLOSED'
  | 'LIQUIDITY_LOW';

/**
 * Компактный логгер для арбитражного бота
 * Минимизирует избыточные логи, показывает только важную информацию
 */
export class CompactLogger {
  private config: Config;
  private minuteStats = {
    opened: [] as { symbol: string; type: 'LONG' | 'SHORT'; profit: number; time: string }[],
    closed: [] as { symbol: string; type: 'LONG' | 'SHORT'; profit: number; pnlUSD: number; reason: string }[],
    skipped: new Map<string, number>(), // reason -> count
    skippedDetails: [] as { symbol: string; reason: string; time: string }[],
    startTime: Date.now(),
  };
  private minuteInterval: NodeJS.Timeout | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Запустить минутные сводки
   */
  start(): void {
    this.minuteStats.startTime = Date.now();
    this.minuteInterval = setInterval(() => {
      this.printMinuteSummary();
    }, 60000); // Каждую минуту
  }

  /**
   * Остановить
   */
  stop(): void {
    if (this.minuteInterval) {
      clearInterval(this.minuteInterval);
      this.minuteInterval = null;
    }
  }

  /**
   * Логировать открытие новой позиции (одна строка)
   * Формат: [НОВАЯ ПОЗИЦИЯ] [XAIUSDT] LONG Открыта в 04:08:15. Куплено на Binance @ 0.0198, Продается на MEXC @ 0.0199. Расч. прибыль: 0.39%
   */
  logPositionOpened(pair: PositionPair): void {
    const time = new Date(pair.openTime).toLocaleTimeString('ru-RU');
    const type = this.getPositionType(pair);
    const buyExchange = pair.longPosition.exchange.toUpperCase();
    const sellExchange = pair.shortPosition.exchange.toUpperCase();
    const buyPrice = pair.longPosition.entryPrice;
    const sellPrice = pair.shortPosition.entryPrice;
    const profit = pair.expectedProfit;

    console.log(
      `\x1b[32m[НОВАЯ ПОЗИЦИЯ]\x1b[0m [\x1b[1m${pair.symbol}\x1b[0m] \x1b[36m${type}\x1b[0m Открыта в ${time}. ` +
      `Куплено на ${buyExchange} @ ${this.formatPrice(buyPrice)}, ` +
      `Продается на ${sellExchange} @ ${this.formatPrice(sellPrice)}. ` +
      `Расч. прибыль: \x1b[33m${profit.toFixed(2)}%\x1b[0m`
    );

    // Добавляем в минутную статистику
    this.minuteStats.opened.push({ symbol: pair.symbol, type, profit, time });
  }

  /**
   * Логировать пропущенную возможность (одна строка)
   * Формат: [ПРОПУЩЕНО] [YFIUSDT] 04:08:17 - Причина: прибыль (0.15%) ниже минимального порога (0.25%)
   */
  logPositionSkipped(
    symbol: string,
    reason: string,
    details?: string
  ): void {
    const time = new Date().toLocaleTimeString('ru-RU');
    const detailsStr = details ? ` - ${details}` : '';

    console.log(
      `\x1b[33m[ПРОПУЩЕНО]\x1b[0m [\x1b[1m${symbol}\x1b[0m] ${time} - Причина: ${reason}${detailsStr}`
    );

    // Добавляем в минутную статистику
    const count = this.minuteStats.skipped.get(reason) || 0;
    this.minuteStats.skipped.set(reason, count + 1);
    this.minuteStats.skippedDetails.push({ symbol, reason, time });
  }

  /**
   * Логировать закрытие позиции (одна строка)
   */
  logPositionClosed(pair: PositionPair, reason: string): void {
    const time = new Date(pair.closeTime || Date.now()).toLocaleTimeString('ru-RU');
    const type = this.getPositionType(pair);
    const profit = pair.actualProfit || 0;
    const profitUSD = (profit / 100) * this.config.trading.positionSizeUSD * 2;
    const status = profit >= 0 ? '\x1b[32m+\x1b[0m' : '\x1b[31m-\x1b[0m';

    console.log(
      `${status} \x1b[36m[ЗАКРЫТА]\x1b[0m [\x1b[1m${pair.symbol}\x1b[0m] ${type} ${time} - ${reason}. ` +
      `P&L: ${profit >= 0 ? '\x1b[32m+' : '\x1b[31m'}${profit.toFixed(2)}%\x1b[0m ($${profitUSD >= 0 ? '+' : ''}${profitUSD.toFixed(2)})`
    );

    // Добавляем в минутную статистику
    this.minuteStats.closed.push({ symbol: pair.symbol, type, profit, pnlUSD: profitUSD, reason });
  }

  /**
   * Вывести динамическую таблицу открытых позиций
   * Формат: [ID] ПАРА | LONG/SHORT | Биржа_покупки: Цена | Биржа_продажи: Цена | Прибыль: X.XX% | Статус
   */
  printPositionTable(
    positions: Map<string, PositionPair>,
    getCurrentPrices?: (symbol: string) => { buyPrice: number; sellPrice: number } | null
  ): void {
    if (positions.size === 0) {
      return;
    }

    console.log('\n\x1b[1m═══ ОТКРЫТЫЕ ПОЗИЦИИ ═══\x1b[0m');

    let index = 1;
    for (const [_, pair] of positions.entries()) {
      const type = this.getPositionType(pair);
      const buyExchange = pair.longPosition.exchange.toUpperCase();
      const sellExchange = pair.shortPosition.exchange.toUpperCase();

      // Текущие цены
      let buyPrice = pair.longPosition.entryPrice;
      let sellPrice = pair.shortPosition.entryPrice;
      if (getCurrentPrices) {
        const prices = getCurrentPrices(pair.symbol);
        if (prices) {
          buyPrice = prices.buyPrice;
          sellPrice = prices.sellPrice;
        }
      }

      // Текущий P&L
      const profit = this.calculateCurrentProfit(pair, getCurrentPrices);

      // Статус
      let status = 'Активна';
      let statusColor = '\x1b[32m'; // green
      if (profit < 0) {
        status = 'В убытке';
        statusColor = '\x1b[31m'; // red
      } else if (profit < 0.1) {
        status = 'Мониторинг';
        statusColor = '\x1b[33m'; // yellow
      }

      console.log(
        `[${index}] \x1b[1m${pair.symbol}\x1b[0m | \x1b[36m${type}\x1b[0m | ` +
        `${buyExchange}: ${this.formatPrice(buyPrice)} | ${sellExchange}: ${this.formatPrice(sellPrice)} | ` +
        `Прибыль: ${profit >= 0 ? '\x1b[32m+' : '\x1b[31m'}${profit.toFixed(2)}%\x1b[0m | ` +
        `${statusColor}${status}\x1b[0m`
      );
      index++;
    }
    console.log('');
  }

  /**
   * Вывести минутную сводку с расчетом Real P&L
   */
  printMinuteSummary(
    openPositions?: Map<string, PositionPair>,
    getCurrentPrices?: (symbol: string) => { buyPrice: number; sellPrice: number } | null
  ): void {
    const now = Date.now();
    const startTime = new Date(this.minuteStats.startTime);
    const endTime = new Date(now);

    const startStr = startTime.toLocaleTimeString('ru-RU');
    const endStr = endTime.toLocaleTimeString('ru-RU');

    console.log('\n\x1b[1m' + '═'.repeat(70) + '\x1b[0m');
    console.log(`\x1b[1m=== СВОДКА за последнюю минуту (${startStr} - ${endStr}) ===\x1b[0m`);
    console.log('\x1b[1m' + '═'.repeat(70) + '\x1b[0m');

    // ═══ ОТКРЫТЫЕ ПОЗИЦИИ ═══
    if (openPositions && openPositions.size > 0) {
      const longCount = Array.from(openPositions.values()).filter(p => this.getPositionType(p) === 'LONG').length;
      const shortCount = openPositions.size - longCount;

      console.log(`\n\x1b[36m📈 ОТКРЫТО ПОЗИЦИЙ: ${openPositions.size}\x1b[0m (${longCount} LONG, ${shortCount} SHORT)`);

      let totalGrossProfit = 0;
      const positionDetails: { symbol: string; type: string; profit: number }[] = [];

      for (const [_, pair] of openPositions.entries()) {
        const type = this.getPositionType(pair);
        const profit = this.calculateCurrentProfit(pair, getCurrentPrices);
        totalGrossProfit += profit;
        positionDetails.push({ symbol: pair.symbol, type, profit });
      }

      // Сортируем по прибыли
      positionDetails.sort((a, b) => b.profit - a.profit);

      for (const pos of positionDetails) {
        const profitStr = pos.profit >= 0 ? `+${pos.profit.toFixed(2)}%` : `${pos.profit.toFixed(2)}%`;
        const color = pos.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
        const suffix = pos.profit < 0 ? ' (грязн.)' : '';
        console.log(`  • ${pos.symbol} (${pos.type}): ${color}${profitStr}${suffix}\x1b[0m`);
      }

      // Расчет Real P&L
      this.printRealPnLCalculation(openPositions, totalGrossProfit, getCurrentPrices);
    } else {
      console.log('\n\x1b[36m📈 ОТКРЫТЫХ ПОЗИЦИЙ: 0\x1b[0m');
    }

    // ═══ ПРОПУЩЕННЫЕ СИГНАЛЫ ═══
    const totalSkipped = Array.from(this.minuteStats.skipped.values()).reduce((a, b) => a + b, 0);
    if (totalSkipped > 0) {
      console.log(`\n\x1b[33m🚫 ПРОПУЩЕНО СИГНАЛОВ: ${totalSkipped}\x1b[0m`);
      for (const [reason, count] of this.minuteStats.skipped.entries()) {
        console.log(`  • ${reason}: ${count}`);
      }
    }

    // ═══ ОТКРЫТЫЕ ЗА МИНУТУ ═══
    if (this.minuteStats.opened.length > 0) {
      console.log(`\n\x1b[32m✅ ОТКРЫТО ЗА МИНУТУ: ${this.minuteStats.opened.length}\x1b[0m`);
      for (const pos of this.minuteStats.opened) {
        console.log(`  • ${pos.symbol} (${pos.type}): ${pos.profit.toFixed(2)}% в ${pos.time}`);
      }
    }

    // ═══ ЗАКРЫТЫЕ ЗА МИНУТУ ═══
    if (this.minuteStats.closed.length > 0) {
      console.log(`\n\x1b[36m📤 ЗАКРЫТО ЗА МИНУТУ: ${this.minuteStats.closed.length}\x1b[0m`);
      let totalClosedPnL = 0;
      for (const pos of this.minuteStats.closed) {
        const color = pos.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
        console.log(`  • ${pos.symbol} (${pos.type}): ${color}${pos.profit >= 0 ? '+' : ''}${pos.profit.toFixed(2)}%\x1b[0m ($${pos.pnlUSD >= 0 ? '+' : ''}${pos.pnlUSD.toFixed(2)}) - ${pos.reason}`);
        totalClosedPnL += pos.pnlUSD;
      }
      const totalColor = totalClosedPnL >= 0 ? '\x1b[32m' : '\x1b[31m';
      console.log(`  \x1b[1mИТОГО за минуту: ${totalColor}$${totalClosedPnL >= 0 ? '+' : ''}${totalClosedPnL.toFixed(2)}\x1b[0m`);
    }

    console.log('\n' + '═'.repeat(70) + '\n');

    // Сбрасываем статистику на следующую минуту
    this.resetMinuteStats();
  }

  /**
   * Вывести расчет Real P&L при закрытии всех позиций
   */
  private printRealPnLCalculation(
    positions: Map<string, PositionPair>,
    grossProfit: number,
    getCurrentPrices?: (symbol: string) => { buyPrice: number; sellPrice: number } | null
  ): void {
    const positionCount = positions.size;
    if (positionCount === 0) return;

    // Комиссии: taker fee на обеих биржах при входе и выходе
    const binanceFee = this.config.fees.binance.taker;
    const mexcFee = this.config.fees.mexc.taker;
    const avgFee = (binanceFee + mexcFee) / 2;
    const totalFees = avgFee * 4; // вход на 2 биржи + выход с 2 бирж

    // Slippage
    const slippage = this.config.slippage.percent * 2; // на вход и выход

    // Чистый P&L
    const netPnL = grossProfit - totalFees - slippage;
    const positionSize = this.config.trading.positionSizeUSD * 2; // LONG + SHORT
    const totalVolume = positionSize * positionCount;
    const netPnLUSD = (netPnL / 100) * totalVolume;

    console.log(`\n\x1b[1m💰 **РАСЧЕТ ПРИ ЗАКРЫТИИ ВСЕХ СЕЙЧАС:**\x1b[0m`);
    console.log(`  1. Валовая прибыль/убыток: ${grossProfit >= 0 ? '+' : ''}${grossProfit.toFixed(2)}%`);
    console.log(`  2. Комиссии (${avgFee.toFixed(3)}%×4 на сделку): -${totalFees.toFixed(3)}%`);
    console.log(`  3. Слиппадж (${this.config.slippage.percent}%×2): -${slippage.toFixed(2)}%`);

    const netColor = netPnL >= 0 ? '\x1b[32m' : '\x1b[31m';
    console.log(`  4. ${netColor}\x1b[1m**ИТОГО ЧИСТЫЙ P&L: ${netPnL >= 0 ? '+' : ''}${netPnL.toFixed(2)}%**\x1b[0m`);
    console.log(`     • Эквивалент в USDT при объеме $${totalVolume.toFixed(0)}: ${netColor}$${netPnLUSD >= 0 ? '+' : ''}${netPnLUSD.toFixed(2)}\x1b[0m`);

    // Рекомендации
    this.printRecommendations(positions, getCurrentPrices);
  }

  /**
   * Вывести рекомендации по позициям
   */
  private printRecommendations(
    positions: Map<string, PositionPair>,
    getCurrentPrices?: (symbol: string) => { buyPrice: number; sellPrice: number } | null
  ): void {
    console.log(`\n\x1b[1m⚡ РЕКОМЕНДАЦИИ:\x1b[0m`);

    const minProfit = 0.1; // Минимальный порог прибыли

    // Чистые издержки (комиссии + слиппадж)
    const binanceFee = this.config.fees.binance.taker;
    const mexcFee = this.config.fees.mexc.taker;
    const fees = (binanceFee + mexcFee) * 2; // вход и выход на 2 биржах
    const slippage = this.config.slippage.percent * 2;
    const totalCosts = fees + slippage;

    for (const [_, pair] of positions.entries()) {
      const type = this.getPositionType(pair);
      const profit = this.calculateCurrentProfit(pair, getCurrentPrices);

      // Чистая прибыль с учетом комиссий
      const netProfit = profit - totalCosts;

      if (netProfit < -0.1) {
        console.log(`  • \x1b[31mЗакрыть ${pair.symbol} (${type}) - убыточная позиция (${profit.toFixed(2)}%)\x1b[0m`);
      } else if (netProfit > minProfit) {
        console.log(`  • \x1b[32mДержать ${pair.symbol} (${type}) - прибыль выше издержек (${profit.toFixed(2)}%)\x1b[0m`);
      } else {
        console.log(`  • \x1b[33m${pair.symbol} (${type}) - на грани, мониторить (${profit.toFixed(2)}%)\x1b[0m`);
      }
    }
  }

  /**
   * Определить тип позиции (LONG/SHORT)
   * LONG = покупка на бирже A (Binance), продажа на бирже B (MEXC)
   * SHORT = наоборот
   */
  private getPositionType(pair: PositionPair): 'LONG' | 'SHORT' {
    // Если longPosition на binance - это LONG, иначе SHORT
    return pair.longPosition.exchange === 'binance' ? 'LONG' : 'SHORT';
  }

  /**
   * Рассчитать текущую прибыль позиции
   */
  private calculateCurrentProfit(
    pair: PositionPair,
    getCurrentPrices?: (symbol: string) => { buyPrice: number; sellPrice: number } | null
  ): number {
    // Если есть функция получения цен - используем актуальные цены
    if (getCurrentPrices) {
      const prices = getCurrentPrices(pair.symbol);
      if (prices) {
        const longPnl = ((prices.buyPrice - pair.longPosition.entryPrice) / pair.longPosition.entryPrice) * 100;
        const shortPnl = ((pair.shortPosition.entryPrice - prices.sellPrice) / pair.shortPosition.entryPrice) * 100;
        return (longPnl + shortPnl) / 2;
      }
    }

    // Иначе используем сохраненный спред
    if (pair.currentSpread !== undefined) {
      // Приблизительный расчет на основе спреда
      return pair.openSpread - pair.currentSpread;
    }

    return pair.expectedProfit || 0;
  }

  /**
   * Форматировать цену (умное количество знаков)
   */
  private formatPrice(price: number): string {
    if (price >= 1000) {
      return price.toFixed(2);
    } else if (price >= 1) {
      return price.toFixed(4);
    } else if (price >= 0.01) {
      return price.toFixed(5);
    } else {
      return price.toFixed(6);
    }
  }

  /**
   * Сбросить минутную статистику
   */
  private resetMinuteStats(): void {
    this.minuteStats = {
      opened: [],
      closed: [],
      skipped: new Map(),
      skippedDetails: [],
      startTime: Date.now(),
    };
  }

  /**
   * Форматировать причину пропуска для логирования
   */
  static formatSkipReason(
    reason: SkipReasonType,
    details?: {
      profitPercent?: number;
      minProfit?: number;
      currentProfit?: number;
      availableBalance?: number;
      requiredBalance?: number;
      maxPositions?: number;
    }
  ): { reason: string; details?: string } {
    switch (reason) {
      case 'PROFIT_BELOW_THRESHOLD':
        return {
          reason: `прибыль (${details?.profitPercent?.toFixed(2)}%) ниже минимального порога (${details?.minProfit?.toFixed(2)}%)`,
        };
      case 'INSUFFICIENT_BALANCE':
        return {
          reason: `недостаточно баланса`,
          details: `требуется $${details?.requiredBalance?.toFixed(0)}, доступно $${details?.availableBalance?.toFixed(0)}`,
        };
      case 'NO_FREE_SLOTS':
        return {
          reason: `превышен лимит позиций (макс: ${details?.maxPositions || 'N/A'})`,
        };
      case 'POSITION_NOT_PROFITABLE':
        return {
          reason: `текущая позиция не прибыльна для замены`,
          details: `текущая прибыль: ${details?.currentProfit?.toFixed(2)}%`,
        };
      case 'SYMBOL_ALREADY_OPEN':
        return {
          reason: `пара уже в работе`,
        };
      case 'SPREAD_CLOSED':
        return {
          reason: `спред уже закрылся (цены выровнялись)`,
        };
      case 'LIQUIDITY_LOW':
        return {
          reason: `недостаточный объем ликвидности на бирже`,
        };
      default:
        return { reason: String(reason) };
    }
  }
}