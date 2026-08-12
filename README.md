<div align="center">

<img src="extension/icon.svg" width="96" alt="pixel-guard">

# pixel-guard

**Pixel-perfect QA вёрстки по макетам Figma** — сверка живой страницы с макетом
*по элементам* (computed CSS + геометрия), а не картинкой. Без Figma REST API
и его лимитов: данные тянет свой плагин через Plugin API.

![Status](https://img.shields.io/badge/status-personal%20%2F%20WIP-orange)
![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-1f1f1f)
![License](https://img.shields.io/badge/license-MIT-7ba7d4)

![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Figma](https://img.shields.io/badge/Figma-Plugin%20API-F24E1E?logo=figma&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white)
![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![esbuild](https://img.shields.io/badge/esbuild-FFCF00?logo=esbuild&logoColor=black)

</div>

---

Отчёт машиночитаемый: селектор + свойство + `figma → actual`, чтобы правку можно
было сделать не открывая макет. План и архитектура — [PLAN.md](PLAN.md).

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
   `http://localhost:8971` для Desktop и `https://localhost:8972` для браузера.
2. В Figma выделить frame(’ы) → запустить плагин **pixel-guard** → Export snapshot.
3. Результат: `snapshots/<frame>.json` (+ `.png`, если включён чекбокс).

Режим отправки в плагине по умолчанию «авто»: в браузере — HTTPS, в Desktop — HTTP.

### Экспорт всего проекта

Кнопка **«Экспорт всего проекта»** обходит все страницы файла, снимает каждый
верхнеуровневый frame и сопоставляет переиспользуемые блоки по компонентам Figma:
инстансы одного компонента схлопываются в один модуль, а те, что встречаются
больше чем на одной странице, помечаются как **сквозные** (header, footer и т.п.).

Результат: снапшот на каждый frame плюс `snapshots/_project.json` со сводкой.

```bash
npm run modules              # все модули проекта
npm run modules -- --shared  # только сквозные
```

```
⇄ footer
    инстансов: 6 · размеры: 1920x1045, 912x1352, 357x2840
    страницы: Page 1/Главная страница, Page 1/Карта товара
```

Практический смысл: сквозной модуль достаточно привязать в карте один раз —
расхождение в нём чинится сразу на всех страницах.

### Figma в браузере

Страница плагина живёт на `https://www.figma.com`, поэтому запрос на `http://` браузер
режет как mixed content — отсюда отдельный HTTPS-слушатель на порту 8972 с
самоподписанным сертификатом (генерируется сам в `config/cert/`, из git исключён).
Один раз открой <https://localhost:8972/ping> (кнопка «🔐 Принять сертификат») и прими
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
