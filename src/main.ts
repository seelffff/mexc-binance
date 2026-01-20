import { ConfigLoader } from './utils/config-loader.js';
import { ArbitrageDetector } from './arbitrage-detector.js';
import { TuiDashboard } from './utils/tui.js';
import { Logger } from './utils/logger.js';
import { ExcelReporter } from './utils/excel-reporter.js';
import { ApiValidator } from './utils/api-validator.js';

async function main() {
  // 1. Сразу инициализируем TUI (Без проверок!)
  // Это захватит экран терминала
  const tui = new TuiDashboard();

  // 2. Создаем логгер и связываем с TUI
  const logger = new Logger(tui);
  tui.log('{green-fg}System starting...{/}');

  // Переменные для graceful shutdown
  let detector: ArbitrageDetector | null = null;
  const sessionStartTime = Date.now();

  try {
    // 3. Загружаем конфиг
    // (Логи от конфига могут на секунду мелькнуть, но TUI их перерисует)
    const configLoader = new ConfigLoader();
    // Валидацию делаем тихо, чтобы не ломать верстку консоль-логами
    // configLoader.validate();
    const config = configLoader.getConfig();
    const apiKeys = configLoader.getApiKeys();

    // 4. Создаем детектор
    detector = new ArbitrageDetector(
      config,
      logger,
      {
        binanceKey: apiKeys.BINANCE_API_KEY,
        binanceSecret: apiKeys.BINANCE_API_SECRET,
        mexcKey: apiKeys.MEXC_API_KEY,
        mexcSecret: apiKeys.MEXC_API_SECRET,
      }
    );
    detector.setTui(tui); // Обязательно связываем!

    // 4.5. Проверка API ключей перед торговлей
    tui.log('{cyan-fg}Проверка API ключей...{/}');

    const validator = new ApiValidator(logger, tui);
    const binanceInstance = detector.getBinanceFutures();
    const mexcInstance = detector.getMexcFutures();

    const validationResult = await validator.validateAll(
      binanceInstance,
      mexcInstance,
      { binance: config.exchanges.binance.enabled, mexc: config.exchanges.mexc.enabled }
    );

    if (!validationResult.success) {
      tui.log('{red-fg}❌ Торговля не может быть запущена из-за ошибок API{/}');
      tui.log('{yellow-fg}Проверьте конфигурацию и API ключи в .env{/}');
      await new Promise(resolve => setTimeout(resolve, 5000));
      tui.destroy();
      process.exit(1);
    }

    tui.log('{green-fg}✅ Все API ключи работают корректно!{/}');

    // 5. Обработка graceful shutdown (Ctrl+C)
    const gracefulShutdown = async () => {
      const sessionEndTime = Date.now();
      tui.log('{yellow-fg}Получен сигнал завершения (Ctrl+C). Закрываем позиции...{/}');

      try {
        if (detector) {
          // 1. Принудительно закрыть все позиции
          const tradeExecutor = detector.getTradeExecutor();
          await tradeExecutor.forceCloseAllPositions();

          // 2. Получить данные для отчета
          const stats = tradeExecutor.getStats();
          const closedPositions = tradeExecutor.getClosedPositions();
          const skippedOpportunities = tradeExecutor.getSkippedOpportunities();
          const tradingErrors = tradeExecutor.getTradingErrors();
          const wsDowntimes = detector.getWsMonitor().getDowntimes();

          // 3. Сгенерировать отчет
          const reporter = new ExcelReporter(logger);
          const openPositionsArray = Array.from(tradeExecutor.getOpenPositions().values());
          const reportPath = await reporter.generateReport(
            closedPositions,
            stats,
            wsDowntimes,
            skippedOpportunities,
            tradingErrors,
            tradeExecutor.getInitialBalance(),
            tradeExecutor.getCurrentBalance(),
            sessionStartTime,
            sessionEndTime,
            openPositionsArray
          );

          tui.log(`{green-fg}Отчет сохранен: ${reportPath}{/}`);

          // 4. Остановить detector
          await detector.stop();
        }

        // 5. Небольшая пауза чтобы пользователь увидел сообщение
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 6. Уничтожить TUI и выйти
        tui.destroy();
        process.exit(0);
      } catch (error) {
        logger.error(`Ошибка при завершении: ${error}`);
        tui.log(`{red-fg}Ошибка при завершении: ${error}{/}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        tui.destroy();
        process.exit(1);
      }
    };

    // ВАЖНО: Устанавливаем handler в TUI, а не в process.on,
    // потому что blessed перехватывает все клавиши включая Ctrl+C
    tui.setShutdownHandler(gracefulShutdown);

    // 6. Запускаем
    tui.log('{blue-fg}Starting Detector...{/}');
    await detector.start();

    // 7. Запускаем обновление заголовка (Header) с актуальным балансом
    const startTime = Date.now();
    const tradeExecutor = detector.getTradeExecutor();

    setInterval(async () => {
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const h = Math.floor(uptimeSeconds / 3600);
        const m = Math.floor((uptimeSeconds % 3600) / 60);
        const s = uptimeSeconds % 60;
        const uptime = `${h}h ${m}m ${s}s`;

        // Актуальный баланс и PnL
        const stats = tradeExecutor.getStats();
        const initialBalance = tradeExecutor.getInitialBalance();
        const openPositions = tradeExecutor.getOpenPositions();

        // Считаем деньги в открытых позициях
        let inPositions = 0;
        for (const pair of openPositions.values()) {
          inPositions += pair.longPosition.sizeUSD + pair.shortPosition.sizeUSD;
        }

        // Реальный PnL = прибыль от закрытых сделок
        const realizedPnl = stats.netProfit;
        const realizedPnlPercent = (realizedPnl / initialBalance) * 100;
        const pnlColor = realizedPnl >= 0 ? '{green-fg}' : '{red-fg}';

        // Получаем балансы с каждой биржи
        let balanceText: string;
        if (!config.trading.testMode) {
          // В реальном режиме показываем балансы каждой биржи
          try {
            const balances = await tradeExecutor.getExchangeBalances();
            const totalBalance = balances.binance + balances.mexc;
            balanceText = `Binance: $${balances.binance.toFixed(0)}, MEXC: $${balances.mexc.toFixed(0)}, Sum: $${totalBalance.toFixed(0)} (+$${inPositions.toFixed(0)} в поз.)`;
          } catch (error) {
            // Если не удалось получить балансы, показываем как раньше
            const freeBalance = tradeExecutor.getCurrentBalance();
            balanceText = `$${freeBalance.toFixed(0)} (+$${inPositions.toFixed(0)} в поз.)`;
          }
        } else {
          // В тестовом режиме показываем один общий баланс
          const freeBalance = tradeExecutor.getCurrentBalance();
          balanceText = `[TEST] $${freeBalance.toFixed(0)} (+$${inPositions.toFixed(0)} в поз.)`;
        }

        tui.updateHeader({
            uptime,
            balance: balanceText,
            pnl: `${pnlColor}${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)} (${realizedPnlPercent.toFixed(2)}%){/}`
        });
    }, 1000);

    // 8. Вечный цикл для удержания процесса (на всякий случай)
    // Обычно WebSocket держит процесс, но это страховка
    setInterval(() => {}, 10000);

  } catch (error) {
    // Если ошибка - выводим в TUI и не закрываемся сразу
    tui.log(`{red-fg}CRITICAL ERROR: ${error instanceof Error ? error.message : String(error)}{/}`);
    tui.log(`{gray-fg}Check error.log file for details{/}`);
    logger.error(`Critical: ${error}`);
  }
}

// Запускаем
main();
