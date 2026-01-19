/**
 * Класс для мониторинга состояния WebSocket соединений
 */

export interface WebSocketDowntime {
  exchange: 'binance' | 'mexc';
  disconnectTime: number;
  reconnectTime?: number;
  durationMs?: number;
  reason: string;
}

export class WebSocketMonitor {
  private downtimes: WebSocketDowntime[] = [];
  private currentDowntime: Map<string, WebSocketDowntime> = new Map();

  /**
   * Зарегистрировать отключение WebSocket
   */
  recordDisconnect(exchange: 'binance' | 'mexc', reason: string): void {
    const downtime: WebSocketDowntime = {
      exchange,
      disconnectTime: Date.now(),
      reason,
    };

    this.currentDowntime.set(exchange, downtime);
  }

  /**
   * Зарегистрировать переподключение WebSocket
   */
  recordReconnect(exchange: 'binance' | 'mexc'): void {
    const downtime = this.currentDowntime.get(exchange);

    if (downtime) {
      const now = Date.now();
      downtime.reconnectTime = now;
      downtime.durationMs = now - downtime.disconnectTime;

      // Перемещаем в архив
      this.downtimes.push(downtime);
      this.currentDowntime.delete(exchange);
    }
  }

  /**
   * Получить все периоды отключения
   */
  getDowntimes(): WebSocketDowntime[] {
    return this.downtimes;
  }

  /**
   * Получить текущие активные отключения
   */
  getCurrentDowntimes(): WebSocketDowntime[] {
    return Array.from(this.currentDowntime.values());
  }

  /**
   * Получить статистику по отключениям
   */
  getStats() {
    const binanceDowntimes = this.downtimes.filter((d) => d.exchange === 'binance');
    const mexcDowntimes = this.downtimes.filter((d) => d.exchange === 'mexc');

    const binanceTotalDowntime = binanceDowntimes.reduce(
      (sum, d) => sum + (d.durationMs || 0),
      0
    );
    const mexcTotalDowntime = mexcDowntimes.reduce(
      (sum, d) => sum + (d.durationMs || 0),
      0
    );

    return {
      totalDisconnects: this.downtimes.length,
      binance: {
        disconnects: binanceDowntimes.length,
        totalDowntimeMs: binanceTotalDowntime,
        totalDowntimeMinutes: (binanceTotalDowntime / 60000).toFixed(2),
      },
      mexc: {
        disconnects: mexcDowntimes.length,
        totalDowntimeMs: mexcTotalDowntime,
        totalDowntimeMinutes: (mexcTotalDowntime / 60000).toFixed(2),
      },
      totalDowntimeMs: binanceTotalDowntime + mexcTotalDowntime,
      totalDowntimeMinutes: ((binanceTotalDowntime + mexcTotalDowntime) / 60000).toFixed(2),
    };
  }

  /**
   * Очистить историю
   */
  clear(): void {
    this.downtimes = [];
    this.currentDowntime.clear();
  }
}
