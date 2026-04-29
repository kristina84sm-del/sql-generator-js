# SQL Generator — Netlify Edition

Генератор SQL-запросов через OpenAI API. Деплоится на Netlify как статический сайт + serverless functions.

## Структура проекта

```
sql-generator-js/
├── netlify/
│   └── functions/
│       ├── generate.js              # Генерация SQL + ER-диаграммы
│       ├── analyze_architecture.js  # Архитектурный аудит
│       └── generate_mock_data.js    # Генерация mock данных
├── public/
│   ├── index.html   # Интерфейс
│   └── config.json  # Настройки (модели, диалекты, температура)
├── netlify.toml     # Конфиг Netlify
└── .gitignore
```

## Деплой на Netlify

### 1. Пушим в GitHub
```bash
git init
git add .
git commit -m "init"git remote add origin https://github.com/твой-username/sql-generator-js.git

git push -u origin main
```

### 2. Подключаем к Netlify
1. Заходим на https://netlify.com
2. New site → Import from Git → выбираем репозиторий
3. Настройки сборки заполнятся автоматически из netlify.toml

### 3. Задаём переменные окружения в Netlify
Site settings → Environment variables → Add variable:

| Переменная      | Значение              |
|-----------------|-----------------------|
| OPENAI_API_KEY  | sk-proj-...           |
| ACCESS_CODE     | придумай свой пароль  |

### 4. Готово!
После деплоя открываем сайт и вводим ACCESS_CODE в поле на странице.

## Локальный запуск (для разработки)

```bash
# Устанавливаем Netlify CLI
npm install -g netlify-cli

# Создаём .env файл с переменными
echo "OPENAI_API_KEY=sk-proj-..." > .env
echo "ACCESS_CODE=мой_пароль" >> .env

# Запускаем локально
netlify dev
```

Откройте http://localhost:8888
