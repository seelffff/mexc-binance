import { BinanceFutures } from '../exchanges/binance-futures.js';
import { MexcFutures } from '../exchanges/mexc-futures.js';
import { Logger } from './logger.js';
import type { TuiDashboard } from './tui.js';

/**
 * Результат проверки API
 */
export interface ApiCheckResult {
  exchange: 'binance' | 'mexc';
  connectivity: boolean;  // Ping успешен
  authentication: boolean; // API ключи работают
  balance?: number;        // Баланс USDT (если auth успешен)
  error?: string;          // Сообщение об ошибке
}

/**
 * Класс для валидации API ключей перед запуском торговли
 */
export class ApiValidator {
  private logger: Logger;
  private tui?: TuiDashboard;

  constructor(logger: Logger, tui?: TuiDashboard) {
    this.logger = logger;
    this.tui = tui;
  }

  /**
   * Проверить API ключи Binance Futures
   */
  async checkBinance(
    binance: BinanceFutures,
    enabled: boolean
  ): Promise<ApiCheckResult> {
    const result: ApiCheckResult = {
      exchange: 'binance',
      connectivity: false,
      authentication: false,
    };

    // Если биржа отключена в конфиге
    if (!enabled) {
      this.log('{yellow-fg}⚠ Binance отключен в конфигурации{/}');
      return result;
    }

    this.log('{cyan-fg}🔍 Проверка Binance Futures API...{/}');

    // 1. Проверка подключения (ping)
    try {
      const pingOk = await binance.healthCheck();
      result.connectivity = pingOk;

      if (pingOk) {
        this.log('{green-fg}  ✓ Подключение к Binance: OK{/}');
      } else {
        this.log('{red-fg}  ✗ Подключение к Binance: FAILED{/}');
        result.error = 'Не удалось подключиться к серверам Binance';
        return result;
      }
    } catch (error) {
      this.log('{red-fg}  ✗ Подключение к Binance: FAILED{/}');
      result.error = `Ping error: ${error instanceof Error ? error.message : String(error)}`;
      return result;
    }

    // 2. Проверка API ключей (getBalance)
    try {
      const balance = await binance.getBalance();
      result.authentication = true;
      result.balance = balance;

      this.log(`{green-fg}  ✓ API ключи Binance: OK{/}`);
      this.log(`{green-fg}  ✓ USDT баланс: $${balance.toFixed(2)}{/}`);
    } catch (error) {
      this.log('{red-fg}  ✗ API ключи Binance: FAILED{/}');
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Парсим код ошибки
      const codeMatch = errorMsg.match(/code[":]+(-?\d+)/i);
      const errorCode = codeMatch ? codeMatch[1] : null;

      if (errorCode === '-1022') {
        result.error = 'Неверная подпись API. Проверьте API ключи в .env файле';
      } else if (errorCode === '-2014') {
        result.error = 'API ключ недействителен';
      } else if (errorCode === '-2015') {
        result.error = 'API ключ не имеет прав на Futures Trading';
      } else {
        result.error = `Auth error: ${errorMsg}`;
      }
    }

    return result;
  }

  /**
   * Проверить API ключи MEXC Futures
   */
  async checkMexc(
    mexc: MexcFutures,
    enabled: boolean
  ): Promise<ApiCheckResult> {
    const result: ApiCheckResult = {
      exchange: 'mexc',
      connectivity: false,
      authentication: false,
    };

    // Если биржа отключена в конфиге
    if (!enabled) {
      this.log('{yellow-fg}⚠ MEXC отключен в конфигурации{/}');
      return result;
    }

    this.log('{cyan-fg}🔍 Проверка MEXC Futures API...{/}');

    // 1. Проверка подключения (ping)
    try {
      const pingOk = await mexc.healthCheck();
      result.connectivity = pingOk;

      if (pingOk) {
        this.log('{green-fg}  ✓ Подключение к MEXC: OK{/}');
      } else {
        this.log('{red-fg}  ✗ Подключение к MEXC: FAILED{/}');
        result.error = 'Не удалось подключиться к серверам MEXC';
        return result;
      }
    } catch (error) {
      this.log('{red-fg}  ✗ Подключение к MEXC: FAILED{/}');
      result.error = `Ping error: ${error instanceof Error ? error.message : String(error)}`;
      return result;
    }

    // 2. Проверка API ключей (getBalance)
    try {
      const balance = await mexc.getBalance();
      result.authentication = true;
      result.balance = balance;

      this.log(`{green-fg}  ✓ API ключи MEXC: OK{/}`);
      this.log(`{green-fg}  ✓ USDT баланс: $${balance.toFixed(2)}{/}`);
    } catch (error) {
      this.log('{red-fg}  ✗ API ключи MEXC: FAILED{/}');
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Парсим код ошибки
      const codeMatch = errorMsg.match(/code[":]+(\d+)/i);
      const errorCode = codeMatch ? codeMatch[1] : null;

      if (errorCode === '1002') {
        result.error = 'MEXC Futures API доступен только institutional пользователям. Отключите MEXC в config.json или получите institutional access: institution@mexc.com';
      } else if (errorCode === '602') {
        result.error = 'Неверная подпись API. Проверьте MEXC API ключи в .env файле';
      } else if (errorCode === '600') {
        result.error = 'API ключ недействителен';
      } else {
        result.error = `Auth error: ${errorMsg}`;
      }
    }

    return result;
  }

  /**
   * Проверить все биржи и вывести итоговый результат
   */
  async validateAll(
    binance: BinanceFutures | null,
    mexc: MexcFutures | null,
    config: { binance: boolean; mexc: boolean }
  ): Promise<{ success: boolean; results: ApiCheckResult[] }> {
    this.log('');
    this.log('{bold}{cyan-fg}═══════════════════════════════════════════{/}');
    this.log('{bold}{cyan-fg}    Проверка API ключей бирж{/}');
    this.log('{bold}{cyan-fg}═══════════════════════════════════════════{/}');
    this.log('');

    const results: ApiCheckResult[] = [];
    let allGood = true;

    // Проверка Binance
    if (binance && config.binance) {
      const binanceResult = await this.checkBinance(binance, config.binance);
      results.push(binanceResult);

      if (!binanceResult.authentication) {
        allGood = false;
      }
      this.log('');
    }

    // Проверка MEXC
    if (mexc && config.mexc) {
      const mexcResult = await this.checkMexc(mexc, config.mexc);
      results.push(mexcResult);

      // MEXC не критично если не работает (можно торговать только на Binance)
      // Но если это единственная биржа - то критично
      if (!mexcResult.authentication && !config.binance) {
        allGood = false;
      }
      this.log('');
    }

    // Итоговый результат
    this.log('{bold}{cyan-fg}═══════════════════════════════════════════{/}');

    if (allGood) {
      this.log('{bold}{green-fg}✓ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ УСПЕШНО!{/}');
      this.log('{green-fg}  Готово к торговле{/}');
    } else {
      this.log('{bold}{red-fg}✗ ПРОВЕРКИ НЕ ПРОЙДЕНЫ!{/}');
      this.log('{red-fg}  Исправьте ошибки перед запуском торговли{/}');

      // Выводим список ошибок
      results.forEach(result => {
        if (result.error) {
          this.log('');
          this.log(`{red-fg}${result.exchange.toUpperCase()}: ${result.error}{/}`);
        }
      });
    }

    this.log('{bold}{cyan-fg}═══════════════════════════════════════════{/}');
    this.log('');

    return { success: allGood, results };
  }

  /**
   * Вывести сообщение в лог и TUI
   */
  private log(message: string): void {
    if (this.tui) {
      this.tui.log(message);
    } else {
      // Удаляем blessed markup для обычного лога
      const cleanMsg = message.replace(/\{[^}]+\}/g, '');
      this.logger.info(cleanMsg);
    }
  }
}
