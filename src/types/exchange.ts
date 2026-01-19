/**
 * Типы данных бирж
 */

export type ExchangeName = 'binance' | 'mexc';

/**
 * Цена пары на бирже
 */
export interface TickerPrice {
  symbol: string;        // Символ пары, например "BTCUSDT"
  price: number;         // Текущая цена (последняя сделка)
  bid: number;           // Лучшая цена покупки
  ask: number;           // Лучшая цена продажи
  // --- НОВОЕ: Ликвидность ---
  bidQty?: number;       // Объем на покупку (доступный для нашей продажи)
  askQty?: number;       // Объем на продажу (доступный для нашей покупки)
  // -------------------------
  timestamp: number;     // Время получения данных (Unix timestamp)
  exchange: ExchangeName; // Название биржи
}

/**
 * Информация о торговой паре
 */
export interface TradingPair {
  symbol: string;          // Символ пары
  baseAsset: string;       // Базовая валюта (BTC в BTCUSDT)
  quoteAsset: string;      // Котируемая валюта (USDT в BTCUSDT)
  volume24h?: number;      // Объем за 24 часа
}

/**
 * Арбитражная возможность
 */
export interface ArbitrageOpportunity {
  symbol: string;
  buyExchange: ExchangeName;   // Где покупать (дешевле)
  sellExchange: ExchangeName;  // Где продавать (дороже)
  buyPrice: number;
  sellPrice: number;
  // --- НОВОЕ: Ликвидность для принятия решений ---
  buyQtyAvailable?: number;    // Доступный объем по ask цене (где покупаем)
  sellQtyAvailable?: number;   // Доступный объем по bid цене (где продаем)
  // ----------------------------------------------
  spreadPercent: number;       // Разница в процентах
  profitPercent: number;       // Прибыль после вычета комиссий
  timestamp: number;
}

/**
 * Статистика 24h для пары
 */
export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  volume: number;
  quoteVolume: number;
  priceChange: number;
  priceChangePercent: number;
  high: number;
  low: number;
}

/**
 * Тип позиции
 */
export type PositionSide = 'LONG' | 'SHORT';

/**
 * Статус позиции
 */
export type PositionStatus = 'OPEN' | 'CLOSED' | 'TIMEOUT_CLOSED' | 'CLOSED_BY_CONVERGENCE';

/**
 * Причина закрытия позиции
 */
export type CloseReason = 'CONVERGENCE' | 'TIMEOUT' | 'MANUAL' | 'FORCE_SHUTDOWN';

/**
 * Снимок цен для истории позиции
 */
export interface PriceSnapshot {
  timestamp: number;
  binancePrice: number;
  mexcPrice: number;
  priceDiffPercent: number;
  spreadPercent: number;
}

/**
 * Открытая позиция на бирже
 */
export interface Position {
  id: string;                     // Уникальный ID позиции
  symbol: string;                 // Торговая пара
  exchange: ExchangeName;         // Биржа
  side: PositionSide;             // LONG или SHORT
  entryPrice: number;             // Цена входа
  exitPrice?: number;             // Цена выхода (если закрыта)
  quantity: number;               // Количество контрактов
  sizeUSD: number;                // Размер позиции в USD
  leverage: number;               // Плечо
  status: PositionStatus;         // Статус позиции
  openTime: number;               // Время открытия (timestamp)
  closeTime?: number;             // Время закрытия (timestamp)
  pnl?: number;                   // Прибыль/убыток в USD
  pnlPercent?: number;            // Прибыль/убыток в %
}

/**
 * Пара позиций (арбитражная пара)
 */
export interface PositionPair {
  id: string;                     // Уникальный ID пары
  symbol: string;                 // Торговая пара
  longPosition: Position;         // LONG позиция (дешевая биржа)
  shortPosition: Position;        // SHORT позиция (дорогая биржа)
  openSpread: number;             // Спред при открытии
  currentSpread?: number;         // Текущий спред
  expectedProfit: number;         // Ожидаемая прибыль %
  actualProfit?: number;          // Фактическая прибыль %
  status: PositionStatus;         // Статус пары
  openTime: number;               // Время открытия
  closeTime?: number;             // Время закрытия
  timeoutAt: number;              // Время автозакрытия по таймауту
  closeReason?: CloseReason;      // Причина закрытия
  currentLongPrice?: number;      // Текущая цена на бирже LONG
  currentShortPrice?: number;     // Текущая цена на бирже SHORT
  priceHistory?: PriceSnapshot[]; // История цен для отчёта
  originalBinancePrice?: number;  // Оригинальная цена Binance при открытии
  originalMexcPrice?: number;     // Оригинальная цена MEXC при открытии
  priceDiffPercent?: number;      // Текущая разница цен в процентах (для сходимости)
}

/**
 * Причина пропуска арбитражной возможности
 */
export type SkipReason =
  | 'INSUFFICIENT_BALANCE'
  | 'POSITION_NOT_PROFITABLE'
  | 'NO_FREE_SLOTS'
  | 'SYMBOL_ALREADY_OPEN'
  | 'PROFIT_BELOW_THRESHOLD'
  | 'SPREAD_CLOSED'
  | 'LIQUIDITY_LOW';

/**
 * Пропущенная арбитражная возможность
 */
export interface SkippedOpportunity {
  timestamp: number;
  symbol: string;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number;
  sellPrice: number;
  spreadPercent: number;
  profitPercent: number;
  reason: SkipReason;
  availableBalance?: number;
  requiredBalance?: number;
  currentPositionProfit?: number;
}
