# pixel-guard — план разработки

Инструмент pixel-perfect QA: сверка живой вёрстки с макетами Figma **по элементам**
(computed CSS + геометрия), а не только картинкой. Без Figma REST API и его лимитов —
данные тянет свой Figma-плагин через Plugin API. Результат — машиночитаемый отчёт,
который скармливается Claude Code для автоматического исправления вёрстки.

Первый потребитель — редизайн корпоративного сайта: проверка вёрстки на dev-стенде,
брейкпоинты 1920 / 912 / 357. Конкретные URL, ключи макета и привязки нод живут
в локальных `config/pages.json` и `maps/*.map.json` (в git только `*.example.*`).

## Зачем свой инструмент

Проверены готовые: Uiprobe, Over.fig, Overlayly, OnePixel, PerfectPixel, Visualign.
Ни один не закрывает связку целиком:

- нет надёжной привязки «конкретный Figma-блок ↔ конкретный HTML-элемент»;
- нет сверки стилей (шрифты/отступы/цвета) по элементам — только визуальный overlay;
- ломаются на недоделанных страницах (блок ещё не свёрстан → сыпется всё сопоставление);
- не понимают переиспользуемые блоки (одна и та же ссылка/карточка в разных местах);
- Figma REST API лимитирован (429, у Uiprobe — 4 probes/month на View-аккаунтах);
- нет вывода, пригодного для агента: нужно «font-size 46→48px у `.hero-title`»,
  а не «страница совпадает на 93%».

## Принятые решения

| Вопрос | Решение |
|---|---|
| Имя/расположение | `~/DEV/pixel-guard` |
| MVP | CSS-сверка по элементам (плагин → JSON → Playwright computedStyle → отчёт) |
| Привязка Figma↔DOM | Автоматический матчинг + ручной override во внешнем map-файле. Никаких `data-figma` атрибутов в теме сайта |
| Интеграция с Claude | CLI + `report.json` / `report.html`. MCP — возможная поздняя фаза |
| Источник данных Figma | Только Plugin API (`figma.currentPage`, `exportAsync()`), REST API не используем |

## Архитектура

```
Figma Desktop
 └─ pixel-guard plugin (TypeScript)
     ├─ обход выбранных frame'ов → дерево нод: имя, тип, x/y/w/h,
     │  fills, шрифты, line-height, letter-spacing, padding/gap (auto-layout),
     │  border-radius, effects, компонент-инстансы
     ├─ exportAsync() → PNG frame'ов (для фаз overlay/pixel-diff)
     └─ POST http://127.0.0.1:<port>/ingest → снапшот на диск

pixel-guard server/CLI (Node.js + TypeScript)
 ├─ ingest-сервер: принимает снапшоты плагина → snapshots/<frame>.json + .png
 ├─ matcher: авто-сопоставление нод ↔ DOM + ручные override из map-файла
 ├─ collector (Playwright): открывает URL на нужном viewport,
 │  для каждой заматченной ноды берёт boundingRect + getComputedStyle
 ├─ comparator: нормализация значений → diff по правилам tolerance
 └─ reporter: report.json (для Claude) + report.html (для глаз)
```

Прогон: `pixel-guard run [--page home] [--viewport desktop]` → exit code 1,
если расхождений больше порога.

## Структура проекта

```
pixel-guard/
├── plugin/                  # Figma plugin (manifest.json, code.ts, ui.html)
├── server/                  # ingest + matcher + collector + comparator + reporter
├── extension/               # Chrome MV3: живой мост Figma ↔ сайт
├── snapshots/               # выгрузки из Figma: <frame>.json + <frame>.png (gitignore)
├── maps/                    # привязки: <page>.map.json (локально, в git — *.example.*)
├── config/pages.json        # page → { url, frame'ы } (локально, в git — *.example.*)
├── reports/                 # report.json / report.html / diff-картинки (gitignore)
└── PLAN.md
```

### `config/pages.json` (создаётся из `config/pages.example.json`)

```json
{
  "home": {
    "url": "https://example.com/",
    "frames": { "desktop": null, "tablet": null, "mobile": null }
  }
}
```

`frames` можно оставить `null`: если плагин снял секцию с адаптивами, он сам
размечает брейкпоинты по ширине (1920 / 912 / 357) в поле `breakpoints`.

### `maps/<page>.map.json`

```json
{
  "994:13213/hero":        { "selector": ".pr-hero",          "source": "auto" },
  "994:13213/hero/title":  { "selector": ".pr-hero h1",       "source": "auto" },
  "994:13213/hero/cta":    { "selector": ".pr-hero .btn-red", "source": "manual" },
  "994:13213/testimonials": { "skip": "not-implemented" }
}
```

`source: auto` перегенерируется матчером, `manual` — никогда не трогается.
`skip` — блок сознательно исключён (не свёрстан / динамический контент).

## Матчер (авто-привязка + ручной override)

Матчинг по совокупности сигналов, сверху вниз по дереву (родитель найден →
дети ищутся внутри его DOM-поддерева):

1. **Текст** — точное/нормализованное совпадение текстового содержимого
   (самый сильный сигнал для заголовков, кнопок, ссылок).
2. **Имя ноды** — эвристика `Hero` → кандидаты `.pr-hero`, `[class*="hero"]`.
3. **Геометрия** — близость x/y/w/h к ожидаемым (с допуском, т.к. вёрстка «плывёт»).
4. **Тип** — TEXT→текстовые элементы, инстанс кнопки→`a`/`button`, IMAGE→`img`/фон.

Скоринг кандидатов; порог уверенности. Ниже порога → нода попадает в отчёт как
`unmatched` с топ-3 кандидатами — руками вписывается селектор в map (становится
`manual`). Матчер НЕ падает, если блока нет: помечает `NOT IMPLEMENTED` и идёт дальше.

Переиспользуемые блоки: инстансы одного компонента матчатся независимо каждый в своём
родительском поддереве — одинаковая карточка в трёх местах = три записи в map.

## Компаратор: правила сверки

Сверяемые свойства (по типам нод):

- типографика: font-family, font-size, font-weight, line-height, letter-spacing,
  text-transform, text-align, color;
- геометрия: width, height, позиция относительно родителя;
- отступы: padding, gap (auto-layout ↔ flex/grid gap), margin между соседями;
- оформление: background-color, border, border-radius, box-shadow, opacity.

Нормализация перед сравнением (иначе тонны ложных фейлов):

- цвета → единый формат (rgb/hex, альфа отдельно);
- line-height проценты/unitless → px; font-weight имена → числа;
- font-family — сравнение первого реального шрифта из стека;
- px — округление, допуск по умолчанию ±1px (геометрия ±2px), настраивается
  per-property и per-node в map (`"tolerance": {...}`);
- то, что заведомо различается (рендер шрифтов, динамический контент), — в ignore.

Результат по ноде: список `{prop, figma, actual, delta, pass}`; по странице —
свод `matched / failed / unmatched / not-implemented` + счёт расхождений.

## Формат `report.json` (контракт для Claude Code)

```json
{
  "page": "home", "viewport": "desktop", "url": "...",
  "score": { "matched": 41, "failed": 12, "unmatched": 3, "notImplemented": 1 },
  "nodes": [{
    "figmaId": "994:13213/hero/title",
    "selector": ".pr-hero h1",
    "status": "failed",
    "diffs": [
      { "prop": "font-size",  "figma": "48px", "actual": "46px", "delta": "-2px" },
      { "prop": "font-weight","figma": "700",  "actual": "600" }
    ]
  }]
}
```

Требование: каждый diff должен быть **достаточен для правки без открытия Figma** —
селектор + свойство + ожидаемое значение.

## Фазы

### Фаза 0 — каркас (½ дня)
- Репозиторий, TypeScript, структура папок, `config/pages.json`.
- Figma-плагин hello-world (официальный plugin starter), запуск в Dev-режиме,
  POST на локальный сервер, снапшот пишется на диск.
- ✅ Готово: нажал кнопку в плагине → в `snapshots/` появился JSON выбранного frame.

### Фаза 1 — MVP: CSS-сверка по элементам (ядро)
- Плагин: полный обход frame → дерево нод со стилями и геометрией.
- Матчер: авто-привязка + map-файл + ручной override + `skip`/`NOT IMPLEMENTED`.
- Collector: Playwright, три viewport'а, boundingRect + computedStyle по map.
- Компаратор с нормализацией и tolerance.
- `report.json` + минимальный `report.html` (таблица нод и диффов).
- CLI: `pixel-guard run --page home --viewport desktop`, exit code по порогу.
- ✅ Готово: прогон по главной выдаёт список конкретных расхождений
  (селектор + свойство + figma/actual), Claude Code правит вёрстку по report.json,
  повторный прогон показывает уменьшение failed.

### Фаза 2 — покрытие и удобство ✅
- ✅ Все страницы в `pages.json`; batch-прогон `npm run qa:all` со сводкой.
- ✅ Авто-матчер `npm run automap` + привязка мышью из панели расширения.
- ✅ Сквозные модули в `maps/_shared.map.json` (@-ключи по имени компонента).
- ✅ `report.html` v2: карточки счёта, сводка «чаще всего расходится», фильтры.
- Команды в `commands-list.json` проекта (запуск сервера, прогоны) — под кнопки
  Commands Extension.

### Фаза 3 — визуальный уровень ✅
- ✅ `npm run pixdiff`: fullPage-скриншот против PNG макета через pixelmatch —
  процент, разбивка по полосам, diff-картинка. Нужен экспорт с чекбоксом PNG.
- ✅ Наложение макета поверх живого сайта из панели (картинка / каркас блоков,
  слайдер прозрачности, difference).
  (crop по boundingRect — точнее, чем вся страница целиком).
- Side-by-side/overlay в `report.html` (opacity-слайдер, split).

### Фаза 4 — опционально, по итогам эксплуатации
- ✅ Живой мост: расширение `extension/` + плагин через SSE-шину ingest-сервера
  (`/bus`, `/emit`). Клик по ноде в Figma → подсветка элемента и дифф в браузере.
  Figma REST API не задействован — лимитов нет by design.
- Overlay-картинкой поверх живого сайта (PNG из exportAsync + слайдер прозрачности).
- MCP-обёртка над CLI: тулзы `check_page`, `get_node_styles`, `get_diff`.
- ✅ Генерация CSS-патчей: `npm run patch` (предложение правок, не автоприменение).

## Что переиспользуем

- **figma/plugin-samples + plugin starter** — каркас плагина (MIT).
- **FigmaToCode** (bernaferrari) — как референс извлечения стилей/структуры из нод
  (код генерации HTML не нужен).
- **Playwright** — браузер, viewport'ы, computedStyle, fullPage-скриншоты.
- **pixelmatch** — попиксельный diff (фаза 3).
- НЕ используем: figma-export-пакеты на REST API (лимиты, токены — то, от чего уходим).

## Риски и грабли

- **Права в Figma**: запуск собственного плагина в Dev-режиме требует edit-доступа
  к файлу (или копии файла). Проверить на своём макете первым делом в фазе 0.
- **Figma в браузере**: iframe плагина на `https://www.figma.com` не может стучаться на
  `http://127.0.0.1` (mixed content). Решено: ingest поднимает и HTTPS-слушатель
  (8972, самоподписанный сертификат в `config/cert/`), плюс фолбэк «скачать JSON» +
  `npm run import`. В Desktop работает прежний HTTP на 8971.
- Figma auto-layout ↔ CSS: gap/padding ложатся на flex прямо, но margin'ы и
  абсолютные ноды потребуют аккуратного пересчёта относительных координат.
- Динамика WordPress: контент из БД отличается от макета → текст-матчинг частично
  не сработает, нужен ручной map; для таких нод сверять только стили, не текст.
- Шрифтовой рендер браузера ≠ Figma: line-height/метрики могут расходиться на 1-2px
  легально — решается tolerance, не считать багом инструмента.
- Проверка идёт по живому dev-серверу (локального PHP нет) — прогоны батчить,
  Playwright не гонять в цикле без нужды.

## Первые задачи (фаза 0 → 1)

1. Каркас репо + tsconfig + структура папок.
2. Плагин-скелет: manifest, UI-кнопка «Export snapshot», POST на `127.0.0.1`.
3. Ingest-сервер: принять и сохранить снапшот.
4. Обход дерева нод в плагине: полный JSON стилей/геометрии (сверить вручную
   с панелью Inspect на 2-3 нодах).
5. Collector на Playwright: по захардкоженному map главной снять computedStyle.
6. Компаратор + нормализация + первый `report.json`.
7. Прогон по главной dev-стенда, разбор ложных срабатываний, донастройка
   tolerance/ignore.
8. Авто-матчер (после того как ядро сверки стабильно на ручном map).
