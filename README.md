# Ozon (FBO) — “Продажи за сегодня” в Telegram Mini App

Это готовый минимальный проект:
- Telegram Bot (кнопка открывает Mini App)
- Mini App (ввод Client-Id + Api-Key один раз)
- Сервер считает “единицы за сегодня” и “сумму товаров за сегодня” по FBO posting'ам.

## Что считается
- Берём все FBO отправления, созданные **сегодня** (по `created_at`) в таймзоне `SALES_TIMEZONE` (по умолчанию Europe/Moscow)
- Считаем:
  - `units = сумма quantity по financial_data.products[]`
  - `sum = сумма (price * quantity)` по financial_data.products[]

## Быстрый запуск (локально)
1) Установите Docker Desktop.
2) Скопируйте `.env.example` в `.env` и заполните:
   - `BOT_TOKEN`
   - `BASE_URL` (для локальной разработки можно временно использовать tunnel, см. ниже)
3) Запуск:
   ```bash
   docker compose up --build
   ```
   Сервер будет на `http://localhost:3000`

### Важно про HTTPS
Telegram Mini App должен открываться по **HTTPS**. Для разработки используйте:
- Cloudflare Tunnel
- ngrok
- или любой VPS с HTTPS (Nginx + Let's Encrypt)

## Настройка бота
1) Создайте бота через @BotFather → получите BOT_TOKEN
2) Задайте WebApp URL:
   - В коде кнопка строится из BASE_URL
   - Укажите BASE_URL = https://ВАШ_ДОМЕН
3) В Telegram откройте бота → /start → “Открыть продажи”

## Продакшн
Разверните на VPS и подключите домен + HTTPS.
