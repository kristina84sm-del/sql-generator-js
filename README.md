# SQL AI Generator — деплой на Amvera
 
## Структура (ВАЖНО — не менять расположение файлов)
```
корень репозитория/
├── netlify/functions/        ← вся бизнес-логика (имя папки сохранено
│   ├── _auth_middleware.js      по историческим причинам, к Netlify
│   ├── _rate_limit_check.js     отношения больше не имеет — Amvera
│   ├── admin_panel.js           их просто требует через server.js)
│   ├── analyze_architecture.js
│   ├── auth.js
│   ├── generate_migration.js
│   ├── generate_mock_data.js
│   ├── generate_sql_tests.js
│   ├── generate.js
│   ├── history.js
│   └── split_service.js
├── public/
│   ├── index.html             ← сайт
│   └── config.json
├── server.js                  ← точка входа, Express-обёртка для Amvera
├── amvera.yaml                ← конфигурация сборки/запуска Amvera
├── package.json
└── package-lock.json
```
 
## Локальный запуск
 
```bash
npm install
 
# Создать .env в корне:
JWT_SECRET=<сгенерировать новый случайный секрет>
DATABASE_URL=postgresql://...
OPENAI_API_KEY=sk-proj-...
 
npm start
```
 
Открыть: http://localhost:3000
 
## Деплой на Amvera
 
1. В личном кабинете Amvera — создать проект, тип Node.js.
2. Подключить GitHub-репозиторий (вкладка "Репозиторий").
3. Переменные окружения (раздел "Переменные окружения"):
   - OPENAI_API_KEY
   - DATABASE_URL
   - JWT_SECRET
4. Деплой запускается автоматически после подключения, далее —
   автоматически при каждом git push в main.
 
## Архитектура
 
Приложение работает как обычный постоянный Node.js-процесс (не
serverless), поэтому ограничений по времени выполнения запроса
практически нет (задан лимит 5 минут в server.js) — это решает
проблему таймаутов на больших схемах, которая была актуальна при
хостинге на Netlify.

