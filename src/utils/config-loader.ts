import { readFileSync } from 'fs';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import type { Config, EnvConfig } from '../types/config.js';

/**
 * Загружает конфигурацию из config.json и .env
 */
export class ConfigLoader {
  private config: Config;
  private env: EnvConfig;

  constructor() {
    // Загружаем .env файл (если существует)
    dotenvConfig();

    // Загружаем config.json
    const configPath = join(process.cwd(), 'config.json');
    const configFile = readFileSync(configPath, 'utf-8');
    this.config = JSON.parse(configFile) as Config;

    // Загружаем env переменные
    this.env = {
      BINANCE_API_KEY: process.env.BINANCE_API_KEY,
      BINANCE_API_SECRET: process.env.BINANCE_API_SECRET,
      MEXC_API_KEY: process.env.MEXC_API_KEY,
      MEXC_API_SECRET: process.env.MEXC_API_SECRET,
    };
  }

  /**
   * Получить полную конфигурацию
   */
  getConfig(): Config {
    return this.config;
  }

  /**
   * Получить API ключи
   */
  getApiKeys() {
    return this.env;
  }

  /**
   * Проверить, что все обязательные параметры заполнены
   */
  validate(): void {
    // Проверяем, что хотя бы одна биржа включена
    const binanceEnabled = this.config.exchanges.binance.enabled;
    const mexcEnabled = this.config.exchanges.mexc.enabled;

    if (!binanceEnabled && !mexcEnabled) {
      throw new Error('Хотя бы одна биржа должна быть включена в config.json');
    }

    // Проверяем параметры арбитража
    if (this.config.arbitrage.minSpreadPercent < 0) {
      throw new Error('minSpreadPercent должен быть >= 0');
    }

    if (this.config.arbitrage.topPairsCount <= 0) {
      throw new Error('topPairsCount должен быть > 0');
    }

    // Предупреждение если WebSocket выключен
    if (!this.config.arbitrage.useWebSocket) {
      console.warn('⚠️  ВНИМАНИЕ: WebSocket выключен! Арбитраж будет работать медленно.');
      console.warn('⚠️  Для реального арбитража установите useWebSocket: true в config.json');
    }

    // Предупреждение если restFallbackIntervalMs = 0 и WebSocket включен
    if (
      this.config.arbitrage.useWebSocket &&
      this.config.arbitrage.restFallbackIntervalMs === 0
    ) {
      console.log(
        '✓ REST fallback отключен. При обрыве WebSocket работа остановится.'
      );
    }

    console.log('✓ Конфигурация валидна');
  }

  /**
   * Вывести краткую информацию о конфигурации
   */
  printSummary(): void {
    console.log('\n📋 Конфигурация арбитражного бота:');
    console.log('─'.repeat(50));

    const { binance, mexc } = this.config.exchanges;
    console.log(
      `🔹 Binance: ${binance.enabled ? '✓ Включен' : '✗ Выключен'}`
    );
    console.log(`🔹 MEXC: ${mexc.enabled ? '✓ Включен' : '✗ Выключен'}`);

    const arb = this.config.arbitrage;
    console.log(`\n⚙️  Параметры:`);
    console.log(`   • Минимальный спред: ${arb.minSpreadPercent}%`);
    console.log(`   • Топ пар для мониторинга: ${arb.topPairsCount}`);
    console.log(`   • WebSocket: ${arb.useWebSocket ? '✓ Да' : '✗ Нет'}`);

    if (!arb.useWebSocket) {
      console.log(`   • REST интервал: ${arb.restFallbackIntervalMs}ms`);
    } else if (arb.restFallbackIntervalMs === 0) {
      console.log(`   • REST fallback: Отключен`);
    } else {
      console.log(`   • REST fallback: ${arb.restFallbackIntervalMs}ms`);
    }

    if (arb.excludePairs.length > 0) {
      console.log(`   • Исключенные пары: ${arb.excludePairs.join(', ')}`);
    }

    const fees = this.config.fees;
    console.log(`\n💰 Комиссии:`);
    console.log(
      `   • Binance: maker ${fees.binance.maker}% / taker ${fees.binance.taker}%`
    );
    console.log(
      `   • MEXC: maker ${fees.mexc.maker}% / taker ${fees.mexc.taker}%`
    );

    console.log('─'.repeat(50) + '\n');
  }
}
