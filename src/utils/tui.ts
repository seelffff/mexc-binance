import blessed from 'blessed';
import type { PositionPair } from '../types/exchange.js';

export class TuiDashboard {
  private screen: blessed.Widgets.Screen;
  private headerBox: blessed.Widgets.BoxElement;
  private scannerBox: blessed.Widgets.BoxElement; // <--- ТЕПЕРЬ ЭТО ПРОСТО BOX
  private activePositionsBox: blessed.Widgets.BoxElement;
  private logBox: blessed.Widgets.Log;
  private statusBox: blessed.Widgets.BoxElement;
  private shutdownHandler?: () => void;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'ARBITRAGE BOT V2',
      fullUnicode: true,
    });

    // 1. Header
    this.headerBox = blessed.box({
      top: 0, left: 0, width: '100%', height: 3,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      content: ' Loading...'
    });

    // 2. Scanner (Слева) - ТЕПЕРЬ ТЕКСТОВЫЙ БЛОК, А НЕ ТАБЛИЦА
    this.scannerBox = blessed.box({
      top: 3, left: 0, width: '60%', height: '50%',
      tags: true,
      border: { type: 'line' },
      label: ' LIVE SCANNER ',
      style: { border: { fg: 'blue' } },
      content: ' Waiting for data...'
    });

    // 3. Active Positions (Справа)
    this.activePositionsBox = blessed.box({
      top: 3, left: '60%', width: '40%', height: '50%',
      tags: true,
      border: { type: 'line' },
      label: ' ACTIVE POSITIONS ',
      style: { border: { fg: 'yellow' } },
      content: ' No active positions'
    });

    // 4. Logs (Низ)
    this.logBox = blessed.log({
      top: '50%+3', left: 0, width: '100%', height: '50%-4',
      tags: true,
      border: { type: 'line' },
      label: ' LOGS ',
      scrollable: true,
      style: { border: { fg: 'gray' } }
    });

    // 5. Status
    this.statusBox = blessed.box({
      bottom: 0, left: 0, width: '100%', height: 1,
      tags: true,
      style: { bg: 'blue', fg: 'white' },
      content: ' Initializing...'
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.scannerBox);
    this.screen.append(this.activePositionsBox);
    this.screen.append(this.logBox);
    this.screen.append(this.statusBox);

    // Обработчик Ctrl+C для graceful shutdown
    this.screen.key(['C-c'], () => {
      if (this.shutdownHandler) {
        this.shutdownHandler();
      } else {
        // Если handler не установлен, выходим сразу
        this.destroy();
        process.exit(0);
      }
    });

    // ESC и Q для быстрого выхода
    this.screen.key(['escape', 'q'], () => {
      this.destroy();
      process.exit(0);
    });

    this.render();
  }

  /**
   * Устанавливает обработчик для graceful shutdown (Ctrl+C)
   */
  public setShutdownHandler(handler: () => void) {
    this.shutdownHandler = handler;
  }

  public updateHeader(stats: { uptime: string; balance: string; pnl: string }) {
    this.headerBox.setContent(
      ` ARBITRAGE BOT | Uptime: ${stats.uptime} | Balance: {green-fg}${stats.balance}{/} | PnL: ${stats.pnl}`
    );
    this.render();
  }

  // РИСУЕМ ТАБЛИЦУ ВРУЧНУЮ (СТРОКАМИ)
  public updateScanner(
    opportunities: { symbol: string; spread: number; profit: number; vol: string }[]
  ) {
    // 1. Заголовок
    let content = `{bold}{cyan-fg}${'SYMBOL'.padEnd(12)} ${'SPREAD'.padEnd(10)} ${'PROFIT'.padEnd(10)} ${'LIQ'.padEnd(10)}{/}\n`;
    content += `{gray-fg}${'-'.repeat(42)}{/}\n`;

    // 2. Сортировка
    const sorted = opportunities.sort((a, b) => b.profit - a.profit).slice(0, 15);

    // 3. Строки данных
    sorted.forEach((opp) => {
      const spreadColor = opp.spread > 0.5 ? '{green-fg}' : '{yellow-fg}';
      const profitColor = opp.profit > 0 ? '{green-fg}' : '{red-fg}';
      
      const sym = opp.symbol.padEnd(12);
      const spr = `${opp.spread.toFixed(2)}%`.padEnd(10);
      const prf = `${opp.profit.toFixed(2)}%`.padEnd(10);
      const vol = opp.vol;

      content += `${sym} ${spreadColor}${spr}{/} ${profitColor}${prf}{/} ${vol}\n`;
    });

    this.scannerBox.setContent(content);
    this.render();
  }

  public updatePositions(positions: PositionPair[]) {
    if (positions.length === 0) {
      this.activePositionsBox.setContent('\n  {gray-fg}No active positions{/}');
    } else {
      let content = '';
      positions.forEach((p) => {
        const profit = p.actualProfit || p.expectedProfit || 0;
        const profitColor = profit >= 0 ? '{green-fg}' : '{red-fg}';
        const timeOpen = Math.floor((Date.now() - p.openTime) / 1000);

        // Форматирование времени
        const mins = Math.floor(timeOpen / 60);
        const secs = timeOpen % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

        // Размер позиции
        const totalSize = p.longPosition.sizeUSD + p.shortPosition.sizeUSD;
        const profitUSD = (profit / 100) * totalSize;
        const profitUSDStr = profitUSD >= 0 ? `+$${profitUSD.toFixed(2)}` : `-$${Math.abs(profitUSD).toFixed(2)}`;

        // Определяем цены входа и текущие цены для каждой биржи
        let binanceEntryPrice: number;
        let binanceCurrentPrice: number;
        let mexcEntryPrice: number;
        let mexcCurrentPrice: number;

        if (p.longPosition.exchange === 'binance') {
          // BINANCE = LONG (купили дешевле), MEXC = SHORT (продали дороже)
          binanceEntryPrice = p.longPosition.entryPrice;
          binanceCurrentPrice = p.currentLongPrice || binanceEntryPrice;
          mexcEntryPrice = p.shortPosition.entryPrice;
          mexcCurrentPrice = p.currentShortPrice || mexcEntryPrice;
        } else {
          // MEXC = LONG (купили дешевле), BINANCE = SHORT (продали дороже)
          mexcEntryPrice = p.longPosition.entryPrice;
          mexcCurrentPrice = p.currentLongPrice || mexcEntryPrice;
          binanceEntryPrice = p.shortPosition.entryPrice;
          binanceCurrentPrice = p.currentShortPrice || binanceEntryPrice;
        }

        // Процентное изменение цен от entryPrice к currentPrice
        const binanceChange = ((binanceCurrentPrice - binanceEntryPrice) / binanceEntryPrice) * 100;
        const mexcChange = ((mexcCurrentPrice - mexcEntryPrice) / mexcEntryPrice) * 100;

        const binanceChangeStr = binanceChange >= 0 ? `{green-fg}+${binanceChange.toFixed(2)}%{/}` : `{red-fg}${binanceChange.toFixed(2)}%{/}`;
        const mexcChangeStr = mexcChange >= 0 ? `{green-fg}+${mexcChange.toFixed(2)}%{/}` : `{red-fg}${mexcChange.toFixed(2)}%{/}`;

        // Сходимость цен - разница между ТЕКУЩИМИ ценами на обеих биржах
        const priceDiff = p.priceDiffPercent || Math.abs(binanceCurrentPrice - mexcCurrentPrice) / Math.min(binanceCurrentPrice, mexcCurrentPrice) * 100;
        let convergenceColor = '{red-fg}';
        if (priceDiff < 0.1) {
          convergenceColor = '{green-fg}'; // Готово к закрытию
        } else if (priceDiff < 0.3) {
          convergenceColor = '{yellow-fg}'; // Близко к закрытию
        }

        // Прогресс-бар для сходимости (10 символов, заполняется когда сходится)
        const maxDiff = 1.0; // Максимальная разница для визуализации
        const progress = Math.max(0, Math.min(1, 1 - (priceDiff / maxDiff)));
        const filled = Math.round(progress * 10);
        const empty = 10 - filled;
        const progressBar = '='.repeat(filled) + '-'.repeat(empty);

        content += `\n{bold}${p.symbol}{/}\n`;
        content += `{gray-fg}├─{/} {bold}BINANCE:{/} ${binanceEntryPrice.toFixed(4)} {gray-fg}→{/} {cyan-fg}${binanceCurrentPrice.toFixed(4)}{/} [${binanceChangeStr}]\n`;
        content += `{gray-fg}├─{/} {bold}MEXC:   {/} ${mexcEntryPrice.toFixed(4)} {gray-fg}→{/} {cyan-fg}${mexcCurrentPrice.toFixed(4)}{/} [${mexcChangeStr}]\n`;
        content += `{gray-fg}├─{/} Сходимость: ${convergenceColor}${priceDiff.toFixed(3)}%{/}  [${convergenceColor}${progressBar}{/}]\n`;
        content += `{gray-fg}├─{/} Время: ${timeStr}\n`;
        content += `{gray-fg}└─{/} PnL если закрыть: ${profitColor}${profitUSDStr}{/} (${profitColor}${profit >= 0 ? '+' : ''}${profit.toFixed(2)}%{/})\n`;
      });
      this.activePositionsBox.setContent(content);
    }
    this.render();
  }

  public log(msg: string) {
    this.logBox.log(msg);
  }

  public setStatus(msg: string) {
    this.statusBox.setContent(` ${msg}`);
    this.render();
  }

  private render() {
    this.screen.render();
  }
  
  public destroy() {
      this.screen.destroy();
  }
}
