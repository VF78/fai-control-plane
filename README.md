# f(AI) Control Plane

Internal MVP supervising multiple projects through GitHub Project and one
project-scoped Hermes per project.

Authority stays external:

- GitHub repository owns code, pull requests, checks and releases.
- GitHub Project owns tasks, status, assignees, dates and dependencies.
- One project-scoped Hermes directly orchestrates and executes manager,
  developer, QA and DevOps work with persistent `git`/`gh`/CLI/SSH credentials.
- PostgreSQL owns only project configuration and sources, identities,
  exact-reference approvals, provider snapshots/cursors, idempotency and audit.

The application has two processes: a Next.js web service and one stateless
worker. The worker only polls authoritative GitHub facts, observes Hermes,
delivers notifications, restarts an unavailable Hermes and launches the next
configured stage; it never brokers provider or CLI commands. The fresh
MVP database is created by `packages/db/mvp-drizzle/0000_mvp.sql`; it does not
read, migrate or delete the legacy database.

## Local start

Copy `.env.example` to `.env`, choose all IDs/configuration explicitly, and
point every `*_HOST_FILE` variable at a host-owned secret file. There are no
default credentials. Compose mounts those files read-only under `/run/secrets`.

```bash
docker compose up -d postgres migrate
docker compose --profile bootstrap run --rm bootstrap
docker compose up --build web worker
```

The bootstrap command is explicit and idempotent: it creates only the first
workspace, owner, identities and tracker credential reference without reading
the secret value. Projects, documents and project-scoped Hermes runtimes are
then created through the product UI.

## Подключение проекта и запуск первой задачи через GUI

После локального запуска войдите в f(AI) Control и откройте раздел «Проекты».
Нажмите «Добавить проект» и заполните «Название проекта», «Короткое имя»,
«Репозиторий GitHub» и «Таск-трекер». Укажите ссылки на уже существующие
репозиторий и GitHub Project, затем нажмите «Подтвердить проект». Репозиторий
остаётся источником кода и pull request, а GitHub Project — источником задач,
исполнителей и статусов; Control Plane сохраняет и проверяет только привязку.

Далее мастер показывает доступный шаг на шкале готовности. Выполните его и
переходите к следующему:

1. В «Документах» загрузите либо «Единый документ», либо оба обязательных
   документа — «Техническое задание» и «Паспорт проекта». Дополнительные
   материалы можно добавить как «Прочее».
2. В «Процессе» проверьте цепочку работы и нажмите «Подтвердить процесс».
   Этапы применяются к тому же GitHub Project и не создают локальный трекер.
3. В «Команде и ролях» добавьте участников и назначьте роли либо выберите
   «Настроить позже»: вернуться к составу можно в «Роли и доступы».
4. В «Коммуникациях» настройте «Внутренний чат» в Telegram. Отдельный «Чат с
   клиентом» поддерживает Telegram или Element; весь шаг можно отложить
   кнопкой «Настроить позже» и завершить позднее в разделе «Чаты». Внутренний
   и клиентский контуры используют раздельные настройки проекта.
5. В «Подключении ИИ-агента» нажмите «Установить ИИ-агента». Для проекта
   создаётся отдельный Hermes со своими данными, памятью, сессиями и рабочей
   папкой. Если появится код устройства, откройте «Открыть вход OpenAI»,
   введите одноразовый код и нажмите «Проверить вход»; авторизация остаётся в
   защищённой среде этого проекта.
6. В «Рабочем контексте» нажмите «Настроить контекст». Hermes читает только
   привязанные репозиторий, таск-трекер и загруженные документы. Если готовой
   архитектуры нет, мастер отдельно предложит её для согласования.
7. В «Настройке таск-трекера» нажмите «Настроить таск-трекер» и, если Hermes
   запросит точное разрешение, подтвердите или отклоните его. f(AI) Control
   проверит итоговые поля и этапы. Это уже реализованная настройка трекера для
   процесса разработки. Универсальное подключение DevOps-доступов и внешних
   систем остаётся отдельной незавершённой задачей #330; текущий мастер не
   следует считать её реализацией.

Когда в «Обзоре» все пункты готовы, в блоке «Первая задача» оставьте режим
«Вставить ссылку на задачу». Вставьте URL существующей незавершённой и
незаблокированной GitHub Issue из подключённого проекта. Проверьте показанные
область работ и критерии приёмки, отметьте «Подтверждаю эту задачу и явно
запускаю ИИ-агента» и нажмите «Назначить и запустить». Это явное действие:
задачи из backlog сами не запускаются. Если ссылка не найдена среди
подтверждённых данных или задача не готова, исправьте состояние в GitHub
Project и обновите данные перед повтором.

После старта откроется карточка в разделе «Задачи». Там видны подтверждённый
этап, исполнитель и состояние запуска; пока работа идёт, результат проверяется
автоматически раз в минуту. Ожидаемый путь одной и той же задачи — `In Dev`,
затем независимая `QA`, затем `Acceptance`, где требуется решение владельца.
Hermes прикладывает PR, результаты проверок и QA evidence к той же GitHub
Issue/PR, а f(AI) Control сверяет факты с GitHub. Уведомления о переходах и
результате приходят во «Внутренний чат» Telegram, если он настроен. Merge,
release, deploy и production остаются отдельными действиями с точным
человеческим одобрением и запуском первой задачи не разрешаются.

## Checks

```bash
pnpm verify:mvp
```

Current product authority and acceptance are defined by GitHub issue #158,
ADR 0006 and the live `f(AI) Studio` Project. Historical ADRs and legacy
branches are not active product scope. Production uses the fail-closed
`scripts/deploy-prod.sh` flow documented in `docs/ops/PRODUCTION_RUNBOOK.md`;
merge and deployment always require separate approval.
