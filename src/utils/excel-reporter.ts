import ExcelJS from 'exceljs';
import type { PositionPair, SkippedOpportunity, CloseReason } from '../types/exchange.js';
import type { WebSocketDowntime } from './websocket-monitor.js';
import { Logger } from './logger.js';

/**
 * Класс для генерации Excel отчетов о торговле
 */
export class ExcelReporter {
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger();
  }

  /**
   * Форматирует причину закрытия для отображения
   */
  private formatCloseReason(reason?: CloseReason): string {
    switch (reason) {
      case 'CONVERGENCE': return 'Сходимость цен';
      case 'TIMEOUT': return 'Таймаут';
      case 'MANUAL': return 'Ручное закрытие';
      case 'FORCE_SHUTDOWN': return 'Принудительное (Ctrl+C)';
      default: return 'Неизвестно';
    }
  }

  /**
   * Генерировать полный отчет в Excel файл
   */
  async generateReport(
    closedPositions: PositionPair[],
    stats: {
      openPositions: number;
      closedPositions: number;
      testStats: {
        totalTrades: number;
        profitableTrades: number;
        losingTrades: number;
        totalProfit: number;
        totalLoss: number;
      };
      winRate: number;
      netProfit: number;
    },
    wsDowntimes: WebSocketDowntime[],
    skippedOpportunities: SkippedOpportunity[],
    initialBalance: number,
    currentBalance: number,
    sessionStartTime: number,
    sessionEndTime: number,
    openPositions?: PositionPair[]
  ): Promise<string> {
    const workbook = new ExcelJS.Workbook();

    // Метаданные
    workbook.creator = 'Arbitrage Bot';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Лист 1: Сводка
    this.createSummarySheet(workbook, stats, initialBalance, currentBalance, sessionStartTime, sessionEndTime);

    // Лист 2: Все сделки
    this.createTradesSheet(workbook, closedPositions);

    // Лист 3: WebSocket downtime
    this.createDowntimeSheet(workbook, wsDowntimes, sessionStartTime, sessionEndTime);

    // Лист 4: Детальная статистика
    this.createDetailedStatsSheet(workbook, closedPositions, stats);

    // Лист 5: Пропущенные возможности
    this.createSkippedOpportunitiesSheet(workbook, skippedOpportunities);

    // Лист 6: Открытые позиции (если есть)
    if (openPositions && openPositions.length > 0) {
      this.createOpenPositionsSheet(workbook, openPositions);
    }

    // Листы истории цен для каждой сделки
    this.createPriceHistorySheets(workbook, closedPositions);

    // Сохраняем файл
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `reports/arbitrage_report_${timestamp}.xlsx`;

    await workbook.xlsx.writeFile(filename);

    this.logger.success(`Excel отчет сохранен: ${filename}`);
    return filename;
  }

  /**
   * Лист 1: Сводная информация
   */
  private createSummarySheet(
    workbook: ExcelJS.Workbook,
    stats: any,
    initialBalance: number,
    currentBalance: number,
    sessionStartTime: number,
    sessionEndTime: number
  ): void {
    const sheet = workbook.addWorksheet('Сводка', {
      views: [{ showGridLines: true }],
    });

    // Настройка ширины колонок
    sheet.columns = [
      { width: 30 },
      { width: 20 },
      { width: 15 },
    ];

    // Заголовок
    sheet.mergeCells('A1:C1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = '📊 ОТЧЕТ ПО АРБИТРАЖНОЙ ТОРГОВЛЕ';
    titleCell.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 30;

    let row = 3;

    // Период работы
    sheet.getCell(`A${row}`).value = '📅 Период работы';
    sheet.getCell(`A${row}`).font = { bold: true, size: 12 };
    row++;

    sheet.getCell(`A${row}`).value = 'Начало сессии:';
    sheet.getCell(`B${row}`).value = new Date(sessionStartTime).toLocaleString('ru-RU');
    row++;

    sheet.getCell(`A${row}`).value = 'Конец сессии:';
    sheet.getCell(`B${row}`).value = new Date(sessionEndTime).toLocaleString('ru-RU');
    row++;

    const durationHours = ((sessionEndTime - sessionStartTime) / 3600000).toFixed(2);
    sheet.getCell(`A${row}`).value = 'Длительность:';
    sheet.getCell(`B${row}`).value = `${durationHours} часов`;
    row += 2;

    // Торговая статистика
    sheet.getCell(`A${row}`).value = '💰 Торговая статистика';
    sheet.getCell(`A${row}`).font = { bold: true, size: 12 };
    row++;

    const tradingData = [
      ['Открытых позиций:', stats.openPositions],
      ['Закрытых сделок:', stats.closedPositions],
      ['Прибыльных сделок:', stats.testStats.profitableTrades],
      ['Убыточных сделок:', stats.testStats.losingTrades],
      ['Win Rate:', `${stats.winRate.toFixed(2)}%`],
      ['Общая прибыль:', `$${stats.testStats.totalProfit.toFixed(2)}`],
      ['Общий убыток:', `$${stats.testStats.totalLoss.toFixed(2)}`],
      ['Чистая прибыль:', `$${stats.netProfit.toFixed(2)}`],
      ['Начальный баланс:', `$${initialBalance.toFixed(2)}`],
      ['Текущий баланс:', `$${currentBalance.toFixed(2)}`],
      ['Изменение баланса:', `$${(currentBalance - initialBalance).toFixed(2)} (${(((currentBalance - initialBalance) / initialBalance) * 100).toFixed(2)}%)`],
    ];

    tradingData.forEach(([label, value]) => {
      sheet.getCell(`A${row}`).value = label;
      sheet.getCell(`B${row}`).value = value;

      // Выделяем чистую прибыль
      if (label === 'Чистая прибыль:') {
        const profitCell = sheet.getCell(`B${row}`);
        profitCell.font = { bold: true, size: 12 };
        profitCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: stats.netProfit > 0 ? 'FFC6EFCE' : 'FFFFC7CE' },
        };
      }

      row++;
    });

    // Форматирование
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        row.eachCell((cell) => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' },
          };
        });
      }
    });
  }

  /**
   * Лист 2: Все сделки
   */
  private createTradesSheet(
    workbook: ExcelJS.Workbook,
    closedPositions: PositionPair[]
  ): void {
    const sheet = workbook.addWorksheet('Сделки');

    // Заголовки
    sheet.columns = [
      { header: 'Pair ID', key: 'pairId', width: 15 },
      { header: 'Symbol', key: 'symbol', width: 12 },
      { header: 'Время открытия', key: 'openTime', width: 20 },
      { header: 'Время закрытия', key: 'closeTime', width: 20 },
      { header: 'Длительность (мин)', key: 'duration', width: 18 },
      { header: 'LONG биржа', key: 'longExchange', width: 12 },
      { header: 'LONG вход', key: 'longEntry', width: 12 },
      { header: 'LONG выход', key: 'longExit', width: 12 },
      { header: 'LONG P&L %', key: 'longPnlPercent', width: 12 },
      { header: 'LONG P&L $', key: 'longPnlUSD', width: 12 },
      { header: 'SHORT биржа', key: 'shortExchange', width: 12 },
      { header: 'SHORT вход', key: 'shortEntry', width: 12 },
      { header: 'SHORT выход', key: 'shortExit', width: 12 },
      { header: 'SHORT P&L %', key: 'shortPnlPercent', width: 12 },
      { header: 'SHORT P&L $', key: 'shortPnlUSD', width: 12 },
      { header: 'Спред открытия %', key: 'openSpread', width: 18 },
      { header: 'Спред закрытия %', key: 'closeSpread', width: 18 },
      { header: 'Общая прибыль %', key: 'totalPnlPercent', width: 18 },
      { header: 'Общая прибыль $', key: 'totalPnlUSD', width: 18 },
      { header: 'Статус', key: 'status', width: 15 },
      { header: 'Причина закрытия', key: 'closeReason', width: 20 },
    ];

    // Фор��атирование заголовков
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 20;

    // Данные
    closedPositions.forEach((pair) => {
      const durationMinutes = pair.closeTime
        ? ((pair.closeTime - pair.openTime) / 60000).toFixed(2)
        : 'N/A';

      // P&L в процентах (из pnlPercent)
      const longPnlPercent = pair.longPosition.pnlPercent ?? 0;
      const shortPnlPercent = pair.shortPosition.pnlPercent ?? 0;
      const totalPnlPercent = pair.actualProfit ?? 0;

      // P&L в USD (из pnl, который уже рассчитан в trade-executor)
      const longPnlUSD = pair.longPosition.pnl ?? 0;
      const shortPnlUSD = pair.shortPosition.pnl ?? 0;
      const totalPnlUSD = longPnlUSD + shortPnlUSD;

      const row = sheet.addRow({
        pairId: pair.id.substring(0, 8),
        symbol: pair.symbol,
        openTime: new Date(pair.openTime).toLocaleString('ru-RU'),
        closeTime: pair.closeTime
          ? new Date(pair.closeTime).toLocaleString('ru-RU')
          : 'N/A',
        duration: durationMinutes,
        longExchange: pair.longPosition.exchange.toUpperCase(),
        longEntry: pair.longPosition.entryPrice.toFixed(4),
        longExit: pair.longPosition.exitPrice?.toFixed(4) || 'N/A',
        longPnlPercent: longPnlPercent.toFixed(2) + '%',
        longPnlUSD: '$' + longPnlUSD.toFixed(2),
        shortExchange: pair.shortPosition.exchange.toUpperCase(),
        shortEntry: pair.shortPosition.entryPrice.toFixed(4),
        shortExit: pair.shortPosition.exitPrice?.toFixed(4) || 'N/A',
        shortPnlPercent: shortPnlPercent.toFixed(2) + '%',
        shortPnlUSD: '$' + shortPnlUSD.toFixed(2),
        openSpread: pair.openSpread.toFixed(2) + '%',
        closeSpread: pair.currentSpread !== undefined ? pair.currentSpread.toFixed(2) + '%' : 'N/A',
        totalPnlPercent: totalPnlPercent.toFixed(2) + '%',
        totalPnlUSD: '$' + totalPnlUSD.toFixed(2),
        status: pair.status,
        closeReason: this.formatCloseReason(pair.closeReason),
      });

      // Раскрашиваем строку в зависимости от прибыли
      if (totalPnlUSD > 0) {
        row.getCell('totalPnlUSD').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' },
        };
      } else if (totalPnlUSD < 0) {
        row.getCell('totalPnlUSD').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' },
        };
      }
    });

    // Форматирование всех ячеек
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    });

    // Фиксируем заголовки
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  }

  /**
   * Лист 3: WebSocket Downtime
   */
  private createDowntimeSheet(
    workbook: ExcelJS.Workbook,
    wsDowntimes: WebSocketDowntime[],
    sessionStartTime: number,
    sessionEndTime: number
  ): void {
    const sheet = workbook.addWorksheet('WebSocket Downtime');

    // Заголовки
    sheet.columns = [
      { header: 'Биржа', key: 'exchange', width: 15 },
      { header: 'Время отключения', key: 'disconnectTime', width: 20 },
      { header: 'Время подключения', key: 'reconnectTime', width: 20 },
      { header: 'Длительность (сек)', key: 'durationSeconds', width: 20 },
      { header: 'Длительность (мин)', key: 'durationMinutes', width: 20 },
      { header: 'Причина', key: 'reason', width: 40 },
    ];

    // Форматирование заголовков
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFF5722' },
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 20;

    // Данные
    wsDowntimes.forEach((downtime) => {
      const durationSeconds = downtime.durationMs
        ? (downtime.durationMs / 1000).toFixed(2)
        : 'N/A';
      const durationMinutes = downtime.durationMs
        ? (downtime.durationMs / 60000).toFixed(2)
        : 'N/A';

      sheet.addRow({
        exchange: downtime.exchange.toUpperCase(),
        disconnectTime: new Date(downtime.disconnectTime).toLocaleString('ru-RU'),
        reconnectTime: downtime.reconnectTime
          ? new Date(downtime.reconnectTime).toLocaleString('ru-RU')
          : 'Еще не подключено',
        durationSeconds,
        durationMinutes,
        reason: downtime.reason,
      });
    });

    // Статистика по downtime
    const binanceDowntimes = wsDowntimes.filter((d) => d.exchange === 'binance');
    const mexcDowntimes = wsDowntimes.filter((d) => d.exchange === 'mexc');

    const binanceTotalMs = binanceDowntimes.reduce(
      (sum, d) => sum + (d.durationMs || 0),
      0
    );
    const mexcTotalMs = mexcDowntimes.reduce((sum, d) => sum + (d.durationMs || 0), 0);

    const sessionDurationMs = sessionEndTime - sessionStartTime;
    const binanceUptimePercent = (
      ((sessionDurationMs - binanceTotalMs) / sessionDurationMs) *
      100
    ).toFixed(2);
    const mexcUptimePercent = (
      ((sessionDurationMs - mexcTotalMs) / sessionDurationMs) *
      100
    ).toFixed(2);

    // Добавляем статистику
    sheet.addRow([]);
    sheet.addRow([]);

    let statsRow = sheet.lastRow!.number + 1;
    sheet.mergeCells(`A${statsRow}:F${statsRow}`);
    const statsTitle = sheet.getCell(`A${statsRow}`);
    statsTitle.value = '📊 СТАТИСТИКА UPTIME';
    statsTitle.font = { bold: true, size: 12 };
    statsTitle.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };
    statsTitle.alignment = { horizontal: 'center' };
    statsRow++;

    sheet.addRow([]);
    statsRow++;

    sheet.getCell(`A${statsRow}`).value = 'Binance отключений:';
    sheet.getCell(`B${statsRow}`).value = binanceDowntimes.length;
    statsRow++;

    sheet.getCell(`A${statsRow}`).value = 'Binance общее downtime:';
    sheet.getCell(`B${statsRow}`).value = `${(binanceTotalMs / 60000).toFixed(2)} мин`;
    statsRow++;

    sheet.getCell(`A${statsRow}`).value = 'Binance uptime:';
    sheet.getCell(`B${statsRow}`).value = `${binanceUptimePercent}%`;
    statsRow++;

    sheet.addRow([]);
    statsRow++;

    sheet.getCell(`A${statsRow}`).value = 'MEXC отключений:';
    sheet.getCell(`B${statsRow}`).value = mexcDowntimes.length;
    statsRow++;

    sheet.getCell(`A${statsRow}`).value = 'MEXC общее downtime:';
    sheet.getCell(`B${statsRow}`).value = `${(mexcTotalMs / 60000).toFixed(2)} мин`;
    statsRow++;

    sheet.getCell(`A${statsRow}`).value = 'MEXC uptime:';
    sheet.getCell(`B${statsRow}`).value = `${mexcUptimePercent}%`;

    // Форматирование
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    });

    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  }

  /**
   * Лист 4: Детальная статистика
   */
  private createDetailedStatsSheet(
    workbook: ExcelJS.Workbook,
    closedPositions: PositionPair[],
    stats: any
  ): void {
    const sheet = workbook.addWorksheet('Детальная статистика');

    sheet.columns = [
      { width: 30 },
      { width: 20 },
    ];

    let row = 1;

    // Заголовок
    sheet.mergeCells(`A${row}:B${row}`);
    const titleCell = sheet.getCell(`A${row}`);
    titleCell.value = '📈 ДЕТАЛЬНАЯ СТАТИСТИКА';
    titleCell.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(row).height = 25;
    row += 2;

    // Торговые пары
    const symbolsTraded = new Set(closedPositions.map((p) => p.symbol));
    sheet.getCell(`A${row}`).value = 'Уникальных торговых пар:';
    sheet.getCell(`B${row}`).value = symbolsTraded.size;
    row++;

    // Средняя длительность сделки
    const avgDuration =
      closedPositions.reduce((sum, p) => {
        return sum + (p.closeTime ? p.closeTime - p.openTime : 0);
      }, 0) / (closedPositions.length || 1);
    sheet.getCell(`A${row}`).value = 'Средняя длительность сделки:';
    sheet.getCell(`B${row}`).value = `${(avgDuration / 60000).toFixed(2)} мин`;
    row++;

    // Средняя прибыль на сделку
    const avgProfit = stats.netProfit / (stats.closedPositions || 1);
    sheet.getCell(`A${row}`).value = 'Средняя прибыль на сделку:';
    sheet.getCell(`B${row}`).value = `$${avgProfit.toFixed(2)}`;
    row++;

    // Лучшая сделка
    const bestTrade = closedPositions.reduce((best, current) => {
      const currentProfit =
        (current.longPosition.pnl || 0) + (current.shortPosition.pnl || 0);
      const bestProfit = (best.longPosition.pnl || 0) + (best.shortPosition.pnl || 0);
      return currentProfit > bestProfit ? current : best;
    }, closedPositions[0]);

    if (bestTrade) {
      const bestProfit =
        (bestTrade.longPosition.pnl || 0) + (bestTrade.shortPosition.pnl || 0);
      sheet.getCell(`A${row}`).value = 'Лучшая сделка:';
      sheet.getCell(`B${row}`).value = `${bestTrade.symbol} (+$${bestProfit.toFixed(2)})`;
      row++;
    }

    // Худшая сделка
    const worstTrade = closedPositions.reduce((worst, current) => {
      const currentProfit =
        (current.longPosition.pnl || 0) + (current.shortPosition.pnl || 0);
      const worstProfit = (worst.longPosition.pnl || 0) + (worst.shortPosition.pnl || 0);
      return currentProfit < worstProfit ? current : worst;
    }, closedPositions[0]);

    if (worstTrade) {
      const worstProfit =
        (worstTrade.longPosition.pnl || 0) + (worstTrade.shortPosition.pnl || 0);
      sheet.getCell(`A${row}`).value = 'Худшая сделка:';
      sheet.getCell(`B${row}`).value = `${worstTrade.symbol} ($${worstProfit.toFixed(2)})`;
      row++;
    }

    // Статистика по биржам
    row += 2;
    sheet.getCell(`A${row}`).value = '🏦 СТАТИСТИКА ПО БИРЖАМ';
    sheet.getCell(`A${row}`).font = { bold: true, size: 12 };
    row++;

    const binanceLongs = closedPositions.filter(
      (p) => p.longPosition.exchange === 'binance'
    );
    const mexcLongs = closedPositions.filter((p) => p.longPosition.exchange === 'mexc');

    sheet.getCell(`A${row}`).value = 'LONG на Binance:';
    sheet.getCell(`B${row}`).value = binanceLongs.length;
    row++;

    sheet.getCell(`A${row}`).value = 'LONG на MEXC:';
    sheet.getCell(`B${row}`).value = mexcLongs.length;
    row++;

    // Форматирование
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });
  }

  /**
   * Лист 5: Пропущенные арбитражные возможности
   */
  private createSkippedOpportunitiesSheet(
    workbook: ExcelJS.Workbook,
    skippedOpportunities: SkippedOpportunity[]
  ): void {
    const sheet = workbook.addWorksheet('Пропущенные возможности', {
      views: [{ showGridLines: true, state: 'frozen', ySplit: 1 }],
    });

    // Настройка колонок
    sheet.columns = [
      { header: 'Дата/Время', key: 'timestamp', width: 20 },
      { header: 'Symbol', key: 'symbol', width: 15 },
      { header: 'Buy Exchange', key: 'buyExchange', width: 12 },
      { header: 'Sell Exchange', key: 'sellExchange', width: 12 },
      { header: 'Buy Price', key: 'buyPrice', width: 12 },
      { header: 'Sell Price', key: 'sellPrice', width: 12 },
      { header: 'Spread %', key: 'spreadPercent', width: 10 },
      { header: 'Profit %', key: 'profitPercent', width: 10 },
      { header: 'Причина', key: 'reason', width: 25 },
      { header: 'Доступный баланс', key: 'availableBalance', width: 18 },
      { header: 'Требуемый баланс', key: 'requiredBalance', width: 18 },
      { header: 'Прибыль текущей позиции %', key: 'currentPositionProfit', width: 25 },
    ];

    // Стиль заголовков
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 25;

    // Данные
    skippedOpportunities.forEach((opp) => {
      const reasonMap: Record<string, string> = {
        'INSUFFICIENT_BALANCE': '💰 Недостаточно баланса',
        'POSITION_NOT_PROFITABLE': '📉 Текущая позиция не прибыльна',
        'MAX_POSITIONS_REACHED': '🚫 Нет свободных слотов',
        'RATE_LIMIT_PENDING': '⏱️ Rate limit - уже создается другой ордер',
        'ORDER_CREATION_FAILED': '❌ Ошибка создания ордера на бирже',
        'POSITION_SIZE_TOO_LARGE': '⚠️ Размер позиции превышает лимит безопасности',
      };

      const reasonText = reasonMap[opp.reason as string] || `Неизвестная причина: ${opp.reason}`;

      sheet.addRow({
        timestamp: new Date(opp.timestamp).toLocaleString('ru-RU'),
        symbol: opp.symbol,
        buyExchange: opp.buyExchange.toUpperCase(),
        sellExchange: opp.sellExchange.toUpperCase(),
        buyPrice: opp.buyPrice.toFixed(4),
        sellPrice: opp.sellPrice.toFixed(4),
        spreadPercent: opp.spreadPercent.toFixed(2) + '%',
        profitPercent: opp.profitPercent.toFixed(2) + '%',
        reason: reasonText,
        availableBalance: opp.availableBalance !== undefined ? '$' + opp.availableBalance.toFixed(2) : '-',
        requiredBalance: opp.requiredBalance !== undefined ? '$' + opp.requiredBalance.toFixed(2) : '-',
        currentPositionProfit: opp.currentPositionProfit !== undefined ? opp.currentPositionProfit.toFixed(2) + '%' : '-',
      });
    });

    // Применяем границы ко всем ячейкам
    const rowCount = sheet.rowCount;
    const colCount = sheet.columnCount;

    for (let row = 1; row <= rowCount; row++) {
      for (let col = 1; col <= colCount; col++) {
        const cell = sheet.getCell(row, col);
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      }
    }

    // Выравнивание для всех ячеек данных
    for (let row = 2; row <= rowCount; row++) {
      sheet.getRow(row).alignment = { vertical: 'middle', horizontal: 'left' };
    }

    // Цветовое кодирование для причин
    for (let row = 2; row <= rowCount; row++) {
      const reasonCell = sheet.getCell(row, 9); // Колонка "Причина"
      if (reasonCell.value === 'Недостаточно баланса') {
        reasonCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' }, // Красный
        };
      } else if (reasonCell.value === 'Текущая позиция не прибыльна') {
        reasonCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFDAB9' }, // Оранжевый
        };
      } else {
        reasonCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFE699' }, // Желтый
        };
      }
    }

    // Если нет пропущенных возможностей
    if (skippedOpportunities.length === 0) {
      sheet.getCell('A2').value = 'Нет пропущенных возможностей';
      sheet.mergeCells('A2:L2');
      sheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getCell('A2').font = { italic: true, color: { argb: 'FF808080' } };
    }
  }

  /**
   * Создает лист с открытыми позициями и расчетом PnL если закрыть
   */
  private createOpenPositionsSheet(
    workbook: ExcelJS.Workbook,
    openPositions: PositionPair[]
  ): void {
    const sheet = workbook.addWorksheet('Открытые позиции');

    // Заголовки
    sheet.columns = [
      { header: 'Пара', key: 'symbol', width: 15 },
      { header: 'Время открытия', key: 'openTime', width: 20 },
      { header: 'Время в позиции', key: 'timeInPosition', width: 18 },
      { header: 'LONG биржа', key: 'longExchange', width: 15 },
      { header: 'LONG вход', key: 'longEntry', width: 12 },
      { header: 'LONG текущ', key: 'longCurrent', width: 12 },
      { header: 'SHORT биржа', key: 'shortExchange', width: 15 },
      { header: 'SHORT вход', key: 'shortEntry', width: 12 },
      { header: 'SHORT текущ', key: 'shortCurrent', width: 12 },
      { header: 'Спред откр %', key: 'openSpread', width: 15 },
      { header: 'Сходимость %', key: 'convergence', width: 15 },
      { header: 'PnL если закрыть %', key: 'potentialPnlPercent', width: 20 },
      { header: 'PnL если закрыть $', key: 'potentialPnlUSD', width: 20 },
    ];

    // Форматирование заголовков
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }, // Синий
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 20;

    // Данные
    openPositions.forEach((pair) => {
      const timeInPosition = Math.floor((Date.now() - pair.openTime) / 1000);
      const mins = Math.floor(timeInPosition / 60);
      const secs = timeInPosition % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      // Расчет потенциального PnL если закрыть сейчас
      const currentLongPrice = pair.currentLongPrice || pair.longPosition.entryPrice;
      const currentShortPrice = pair.currentShortPrice || pair.shortPosition.entryPrice;

      const longPnlPercent = ((currentLongPrice - pair.longPosition.entryPrice) / pair.longPosition.entryPrice) * 100;
      const shortPnlPercent = ((pair.shortPosition.entryPrice - currentShortPrice) / pair.shortPosition.entryPrice) * 100;

      // Вычитаем комиссии
      const fees = 0.12; // Примерные комиссии
      const totalPnlPercent = ((longPnlPercent + shortPnlPercent) / 2) - fees;

      const totalSize = pair.longPosition.sizeUSD + pair.shortPosition.sizeUSD;
      const totalPnlUSD = (totalPnlPercent / 100) * totalSize;

      // Сходимость цен
      const convergence = pair.priceDiffPercent || 0;

      const row = sheet.addRow({
        symbol: pair.symbol,
        openTime: new Date(pair.openTime).toLocaleString('ru-RU'),
        timeInPosition: timeStr,
        longExchange: pair.longPosition.exchange.toUpperCase(),
        longEntry: pair.longPosition.entryPrice.toFixed(4),
        longCurrent: currentLongPrice.toFixed(4),
        shortExchange: pair.shortPosition.exchange.toUpperCase(),
        shortEntry: pair.shortPosition.entryPrice.toFixed(4),
        shortCurrent: currentShortPrice.toFixed(4),
        openSpread: pair.openSpread.toFixed(2) + '%',
        convergence: convergence.toFixed(3) + '%',
        potentialPnlPercent: totalPnlPercent.toFixed(2) + '%',
        potentialPnlUSD: '$' + totalPnlUSD.toFixed(2),
      });

      // Раскрашиваем PnL
      if (totalPnlUSD > 0) {
        row.getCell('potentialPnlUSD').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' }, // Зеленый
        };
        row.getCell('potentialPnlPercent').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' },
        };
      } else {
        row.getCell('potentialPnlUSD').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' }, // Красный
        };
        row.getCell('potentialPnlPercent').fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' },
        };
      }

      // Раскрашиваем сходимость
      const convergenceCell = row.getCell('convergence');
      if (convergence < 0.1) {
        convergenceCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' }, // Зеленый - готово к закрытию
        };
      } else if (convergence < 0.3) {
        convergenceCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFFF99' }, // Желтый - близко
        };
      } else {
        convergenceCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' }, // Красный - далеко
        };
      }

      // Центрируем все ячейки
      row.eachCell((cell) => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    // Фиксируем заголовки
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  }

  /**
   * Создает листы истории цен для каждой закрытой сделки
   */
  private createPriceHistorySheets(
    workbook: ExcelJS.Workbook,
    closedPositions: PositionPair[]
  ): void {
    closedPositions.forEach((pair) => {
      // Пропускаем если нет истории цен
      if (!pair.priceHistory || pair.priceHistory.length === 0) {
        return;
      }

      // Название листа: SYMBOL_ID (макс 31 символ для Excel)
      const shortId = pair.id.substring(0, 8);
      const sheetName = `${pair.symbol}_${shortId}`.substring(0, 31);

      const sheet = workbook.addWorksheet(sheetName);

      // Заголовки
      sheet.columns = [
        { header: 'Время', key: 'time', width: 20 },
        { header: 'Binance Price', key: 'binancePrice', width: 15 },
        { header: 'MEXC Price', key: 'mexcPrice', width: 15 },
        { header: 'Разница цен %', key: 'priceDiff', width: 15 },
        { header: 'Спред %', key: 'spread', width: 12 },
      ];

      // Форматирование заголовков
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF2E7D32' }, // Зеленый
      };
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
      headerRow.height = 20;

      // Данные истории цен
      pair.priceHistory.forEach((snapshot) => {
        sheet.addRow({
          time: new Date(snapshot.timestamp).toLocaleString('ru-RU'),
          binancePrice: snapshot.binancePrice.toFixed(6),
          mexcPrice: snapshot.mexcPrice.toFixed(6),
          priceDiff: snapshot.priceDiffPercent.toFixed(4) + '%',
          spread: snapshot.spreadPercent.toFixed(4) + '%',
        });
      });

      // Добавляем информацию о сделке в начало
      sheet.insertRow(1, []);
      sheet.insertRow(1, []);
      sheet.insertRow(1, []);

      sheet.getCell('A1').value = `Сделка: ${pair.symbol}`;
      sheet.getCell('A1').font = { bold: true, size: 14 };

      sheet.getCell('A2').value = `LONG: ${pair.longPosition.exchange.toUpperCase()} @ ${pair.longPosition.entryPrice.toFixed(4)}`;
      sheet.getCell('A3').value = `SHORT: ${pair.shortPosition.exchange.toUpperCase()} @ ${pair.shortPosition.entryPrice.toFixed(4)}`;

      // Форматирование всех ячеек данных
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 4) { // Пропускаем заголовок информации
          row.eachCell((cell) => {
            cell.border = {
              top: { style: 'thin' },
              left: { style: 'thin' },
              bottom: { style: 'thin' },
              right: { style: 'thin' },
            };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
          });
        }
      });

      // Фиксируем заголовки
      sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 4 }];
    });
  }
}