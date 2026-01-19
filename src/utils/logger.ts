import winston from 'winston';
import path from 'path';
import fs from 'fs';
import type { TuiDashboard } from './tui.js';

export class Logger {
  private fileLogger: winston.Logger;
  private tui?: TuiDashboard;

  constructor(tui?: TuiDashboard) {
    this.tui = tui;

    // Создаем папку для логов сессии
    const dateStr = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const logDir = path.join('logs', `session_${dateStr}`);
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Настраиваем Winston
    this.fileLogger = winston.createLogger({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(logDir, 'trades.log'), level: 'info' }),
        new winston.transports.File({ filename: path.join(logDir, 'debug.log'), level: 'debug' }),
      ],
    });
  }

  public setTui(tui: TuiDashboard) {
    this.tui = tui;
  }

  info(msg: string) {
    this.fileLogger.info(msg);
    if (this.tui) {
      if (!msg.includes('tick')) this.tui.log(`{cyan-fg}ℹ{/} ${msg}`);
    } else {
      console.log(`INFO: ${msg}`);
    }
  }

  success(msg: string) {
    this.fileLogger.info(msg);
    if (this.tui) this.tui.log(`{green-fg}✓ ${msg}{/}`);
    else console.log(`SUCCESS: ${msg}`);
  }

  warn(msg: string) {
    this.fileLogger.warn(msg);
    if (this.tui) this.tui.log(`{yellow-fg}⚠ ${msg}{/}`);
    else console.warn(`WARN: ${msg}`);
  }

  error(msg: string) {
    this.fileLogger.error(msg);
    if (this.tui) this.tui.log(`{red-fg}✗ ${msg}{/}`);
    else console.error(`ERROR: ${msg}`);
  }

  trade(msg: string) {
      this.fileLogger.info({ type: 'TRADE', msg });
      if (this.tui) this.tui.log(`{magenta-fg}💰 ${msg}{/}`);
  }

  debugData(label: string, data: any) {
    this.fileLogger.debug({ label, ...data });
  }

  // === ВОТ ЭТОГО НЕ ХВАТАЛО ===
  header(msg: string) {
    this.fileLogger.info(`=== ${msg} ===`);
    if (this.tui) {
        this.tui.log(`\n{bold}{white-fg}=== ${msg} ==={/}\n`);
    } else {
        console.log(`\n=== ${msg} ===\n`);
    }
  }

  separator() {
      // Заглушка, чтобы не падало, если где-то вызовется
  }
}
