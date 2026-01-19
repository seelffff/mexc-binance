#!/usr/bin/env node

/**
 * Скрипт для тестирования API подключения к Binance и MEXC
 * Проверяет только чтение данных, без создания ордеров
 */

import 'dotenv/config';
import crypto from 'crypto';

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET;

console.log('🔍 Проверка API подключения...\n');

// Тест 1: Binance Futures - получить баланс
async function testBinanceBalance() {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;

    const signature = crypto
      .createHmac('sha256', BINANCE_API_SECRET)
      .update(queryString)
      .digest('hex');

    const url = `https://fapi.binance.com/fapi/v2/balance?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    const balances = await response.json();
    const usdt = balances.find(b => b.asset === 'USDT');

    console.log('✅ Binance Futures API - работает');
    console.log(`   USDT баланс: ${usdt ? usdt.availableBalance : '0'}`);
    return true;
  } catch (error) {
    console.log('❌ Binance Futures API - ошибка');
    console.log(`   ${error.message}`);
    return false;
  }
}

// Тест 2: MEXC Futures - получить баланс
async function testMexcBalance() {
  try {
    const timestamp = Date.now();

    // MEXC подпись для GET: AccessKey + Timestamp (пустое тело)
    const signaturePayload = MEXC_API_KEY + timestamp;

    const signature = crypto
      .createHmac('sha256', MEXC_API_SECRET)
      .update(signaturePayload)
      .digest('hex');

    const url = `https://contract.mexc.com/api/v1/private/account/assets`;

    const response = await fetch(url, {
      headers: {
        'ApiKey': MEXC_API_KEY,
        'Request-Time': timestamp.toString(),
        'Signature': signature,
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(`API Error: ${JSON.stringify(result)}`);
    }

    const usdt = result.data?.find(a => a.currency === 'USDT');

    console.log('✅ MEXC Futures API - работает');
    console.log(`   USDT баланс: ${usdt ? usdt.availableBalance : '0'}`);
    return true;
  } catch (error) {
    console.log('❌ MEXC Futures API - ошибка');
    console.log(`   ${error.message}`);
    return false;
  }
}

// Запуск тестов
async function main() {
  console.log('API ключи загружены из .env файла\n');

  const binanceOk = await testBinanceBalance();
  console.log('');
  const mexcOk = await testMexcBalance();

  console.log('\n' + '='.repeat(50));
  if (binanceOk && mexcOk) {
    console.log('✅ Все API работают! Готово к тестированию.');
  } else {
    console.log('⚠️  Есть проблемы с API. Проверьте ключи в .env файле.');
    console.log('\nИнструкции:');
    console.log('1. Убедитесь что API ключи имеют права на Futures торговлю');
    console.log('2. Проверьте что IP адрес добавлен в whitelist (если требуется)');
    console.log('3. Для MEXC проверьте что используете правильный тип ключей (Futures, не Spot)');
  }
  console.log('='.repeat(50));
}

main().catch(console.error);
