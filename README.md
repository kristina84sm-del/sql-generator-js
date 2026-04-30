# SQL Generator v2 — Netlify + Личный кабинет

Генератор SQL-запросов через OpenAI API с авторизацией пользователей и подсчётом запросов.

## Что нового в v2

- **Личный кабинет**: регистрация, вход, JWT-авторизация
- **Без кода доступа**: вместо общего ACCESS_CODE — логин/пароль для каждого пользователя
- **Счётчик запросов**: каждый запрос к API логируется и отображается в профиле
- **БД Amvera (PostgreSQL)**: хранение пользователей и истории запросов
- **Безопасность**: системные промпты больше не видны на клиенте, ограничена длина входных данных
- **Вся старая функциональность сохранена**: генерация SQL+ERD, аудит архитектуры, mock data, экспорт MD

## Структура проекта

```
sql-generator-js/
├── netlify/
│   └── functions/
│       ├── auth.js                  # Регистрация / вход / /me
│       ├── _auth_middleware.js      # Проверка JWT + логирование (общий модуль)
│       ├── generate.js              # Генерация SQL + ER-диаграммы
│       ├── analyze_architecture.js  # Архитектурный аудит
│       └── generate_mock_data.js    # Генерация mock данных
├── public/
│   ├── index.html                   # Интерфейс (с ЛК)
│   └── config.json                  # Настройки (модели, диалекты)
├── package.json                     # Зависимости (pg)
├── netlify.toml                     # Конфиг Netlify
└── README.md
```

## Деплой

### 1. Подготовка БД на Amvera

Создайте PostgreSQL-базу на Amvera Cloud. Схема создаётся автоматически при первом запросе.

Вручную (при необходимости):
```sql
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64) UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(64) NOT NULL,
  salt          VARCHAR(32) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS request_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  endpoint   VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 2. Push в GitHub

```bash
git init
git add .
git commit -m "v2: auth + user accounts"
git remote add origin https://github.com/ВАШ-USERNAME/sql-generator-js.git
git push -u origin main
```

### 3. Подключение к Netlify

1. https://netlify.com → New site → Import from Git
2. Выбрать репозиторий. Настройки сборки заполнятся из netlify.toml автоматически.

### 4. Переменные окружения в Netlify

Site settings → Environment variables → Add variable:

| Переменная      | Описание                                    | Пример                                        |
|-----------------|---------------------------------------------|-----------------------------------------------|
| OPENAI_API_KEY  | Ключ OpenAI                                 | sk-proj-...                                   |
| DATABASE_URL    | Строка подключения к PostgreSQL (Amvera)    | postgresql://user:pass@host:5432/dbname       |
| JWT_SECRET      | Секрет для подписи токенов (любая строка)   | super-secret-random-string-min-32-chars       |

> ⚠️ JWT_SECRET должен быть случайным и длинным (минимум 32 символа). Никому не сообщать.
> ⚠️ ACCESS_CODE больше не нужен — удалите его из переменных окружения.

### 5. Готово!

После деплоя откройте сайт → зарегистрируйтесь → пользуйтесь.

## Безопасность

- Системные промпты хранятся только на сервере (в коде functions)
- Входные данные обрезаются на сервере: user_prompt ≤ 4000 симв., schema ≤ 8000, rules ≤ 2000
- Пароли хранятся как HMAC-SHA256 с солью (не в открытом виде)
- JWT-токен живёт 7 дней, хранится в localStorage
- Все эндпоинты проверяют токен; без авторизации — 401

## Локальный запуск

```bash
npm install           # установит зависимость pg
npm install -g netlify-cli

# Создаём .env
echo "OPENAI_API_KEY=sk-proj-..."  > .env
echo "DATABASE_URL=postgresql://..." >> .env
echo "JWT_SECRET=my-local-secret-min-32-chars" >> .env

netlify dev
```

Откройте http://localhost:8888
