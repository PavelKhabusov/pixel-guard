# pixel-guard

Pixel-perfect QA: сверка живой вёрстки с макетами Figma по элементам (computed CSS +
геометрия) без Figma REST API. План и архитектура — [PLAN.md](PLAN.md).

## Установка

```bash
npm install
npm run build:plugin
npm run server   # создаст config/pages.json и maps/home.map.json из *.example.*
```

Локальные `config/pages.json` и `maps/*.map.json` в git не попадают: в них URL
твоего стенда и привязки нод конкретного макета. В репозитории лежат только
`config/pages.example.json` и `maps/home.example.map.json` — они копируются
автоматически при первом запуске, дальше заполняешь под свой проект.

Плагин (нужен edit-доступ к файлу или его копия в драфтах):
**Plugins → Development → Import plugin from manifest…** → `plugin/manifest.json`.
Работает и в Figma Desktop, и в браузерной Figma.

## Снапшот макета

1. `npm run server` (или кнопка «▶ Ingest server») — поднимает сразу два слушателя:
   `http://127.0.0.1:8971` для Desktop и `https://127.0.0.1:8972` для браузера.
2. В Figma выделить frame(’ы) → запустить плагин **pixel-guard** → Export snapshot.
3. Результат: `snapshots/<frame>.json` (+ `.png`, если включён чекбокс).

Режим отправки в плагине по умолчанию «авто»: в браузере — HTTPS, в Desktop — HTTP.

### Figma в браузере

Страница плагина живёт на `https://www.figma.com`, поэтому запрос на `http://` браузер
режет как mixed content — отсюда отдельный HTTPS-слушатель на порту 8972 с
самоподписанным сертификатом (генерируется сам в `config/cert/`, из git исключён).
Один раз открой <https://127.0.0.1:8972/ping> (кнопка «🔐 Принять сертификат») и прими
предупреждение — дальше Export snapshot работает как в Desktop.

Если с сертификатом не сложилось — режим «только скачать файл» (или кнопка «Скачать
JSON»): плагин отдаёт снапшот файлом, дальше

```bash
npm run import -- ~/Downloads/<frame>.pg.json
```

## Живой мост Figma ↔ браузер

Расширение `extension/` соединяется с тем же ingest-сервером, что и плагин
(SSE `/bus`), поэтому Figma REST API не используется вообще — никаких лимитов.

1. `npm run server`.
2. Chrome → `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное»
   → папка `extension/`.
3. В плагине включить чекбокс **живой режим**.
4. Кликаешь ноду в Figma → в активной вкладке подсвечивается элемент по
   `maps/<page>.map.json` и всплывает панель со сверкой стилей.

Схема: плагин → `POST /emit` → сервер → SSE → background.js → content.js.
Значок расширения показывает `on`/`off`, попап — кто сейчас на шине.

## Прогон сверки

```bash
npm run qa -- --page home --viewport desktop           # снапшот ищется по frameId из config/pages.json
npm run qa -- --page home --snapshot snapshots/x.json  # или явно
```

Карта привязок — `maps/<page>.map.json`: ключ = имя-путь ноды (`hero/title`) или её id
(`994:13213`), значение — `{ "selector": "...", "tolerance": {...}, "ignore": [...] }`
либо `{ "skip": "причина" }`. Результат: `reports/<page>-<viewport>.json` (для Claude)
и `.html` (для глаз); exit 1 при расхождениях.
