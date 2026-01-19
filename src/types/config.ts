/**
 * Типы для конфигурации приложения
 */

export interface ExchangeConfig {
  name: string;
  restBaseUrl: string;
  wsBaseUrl: string;
  enabled: boolean;
}

export interface ArbitrageConfig {
  minSpreadPercent: number;
  topPairsCount: number;
  useWebSocket: boolean;
  restFallbackIntervalMs: number;
  reconnectDelayMs: number;
  excludePairs: string[];
}

export interface NotificationConfig {
  logToConsole: boolean;
  minSpreadToNotify: number;
  showTimestamp: boolean;
  coloredOutput: boolean;
}

export interface FeeConfig {
  maker: number;
  taker: number;
  _info?: string;
}

export type MarginMode = 'cross' | 'isolated';

export interface TradingConfig {
  enabled: boolean;
  testMode: boolean;
  testBalanceUSD: number;
  positionSizeUSD: number;
  marginMode: MarginMode;
  leverage: number;
  maxOpenPositions: number;
  positionTimeoutSeconds: number;
  closeOnSpreadConvergence: boolean;
  closeOnNewOpportunity: boolean;
  priceConvergencePercent: number;  // Порог сходимости цен для закрытия позиции (0.05 = 0.05%)
}

export interface SlippageConfig {
  percent: number;
  _comment?: string;
  _percent?: string;
}

export interface Config {
  _comment?: string;
  exchanges: {
    binance: ExchangeConfig;
    mexc: ExchangeConfig;
  };
  arbitrage: ArbitrageConfig;
  notifications: NotificationConfig;
  fees: {
    _comment?: string;
    binance: FeeConfig;
    mexc: FeeConfig;
  };
  slippage: SlippageConfig;
  trading: TradingConfig;
}

export interface EnvConfig {
  BINANCE_API_KEY?: string;
  BINANCE_API_SECRET?: string;
  MEXC_API_KEY?: string;
  MEXC_API_SECRET?: string;
}
