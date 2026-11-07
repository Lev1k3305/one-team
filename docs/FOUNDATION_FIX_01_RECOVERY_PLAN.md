# ONE TEAM — FOUNDATION FIX 01: RECOVERY AUDIT & SPECIFICATION PLAN
**Дата аудита:** Март 2026 г.
**Базовый HEAD репозитория:** `633e5c55f52f36efc0b225ebd7bdbc194f9180ff`
**Ветка:** `main`
**Статус:** Pre-Recovery Audit Complete / Pending Approval

---

## 1. Краткое описание текущего состояния репозитория

В результате глубокого аудита файловой системы и истории Git установлено:
1. **Чистое исходное состояние (Clean Working Tree):**
   - Рабочее дерево полностью совпадает с коммитом `633e5c5` (PR #1: интеграция Capacitor 8).
   - Никаких незакоммиченных или staged изменений в текущей песочнице нет (`git status` чист).
   - Локальные артефакты предыдущих сессий в рабочей копии отсутствуют.
2. **Базовые сервисы данных в репозитории на данный момент:**
   - `src/services/storage.ts`: legacy-реализация `StorageService` на синхронном `localStorage` и асинхронном неизолированном `indexedDbEngine` (`OneTeamDB_v1`).
   - `src/services/indexedDb.ts`: база `OneTeamDB_v1` (v1) без разделения ключей по workspaceId / userId.
   - `src/services/indexedDbMigration.ts`: сервис миграции локальных данных в Supabase.
   - `src/context/AuthContext.tsx`: стандартный контекст аутентификации без генераций сессий (`sessionGenerationManager`) и без экспорта `storageContext`.
   - `src/context/AppContext.tsx`: базовый контекст, напрямую использующий синглтон `storageService` и `cloudDataService.loadWorkspaceData`.

---

## 2. Перечень отсутствующих компонентов Foundation Fix 01

Для полноценного функционирования архитектуры Foundation Fix 01 отсутствуют следующие ключевые модули и изменения:

1. **`src/services/storageContext.ts`**:
   - Интерфейс `StorageContext` (`userId`, `workspaceId`, `sessionGeneration`, `isGuest`).
   - Синглтон `sessionGenerationManager`:
     - отслеживание текущего поколения сессии;
     - создание и инвалидация `AbortController` / `AbortSignal`;
     - проверка актуальности операций (`isCurrent(generation)`).
2. **`src/services/indexedDbV2.ts`**:
   - Движок `IsolatedStorageEngine` (`OneTeamDB_v2`, версия 1).
   - Изоляция ключей с префиксами:
     - Workspace-scoped: `${workspaceId}#${entityId}` (`tasks`, `projects`, `clients`, `transactions`, `goals`, `priorities`, `plan`, `mission`, `vision`, `settings`).
     - User-scoped: `${userId}#${entityId}` (`notifications`, `user_profile`).
   - Прямое связывание `AbortSignal` с транзакциями IndexedDB (`tx.abort()` при смене контекста).
   - Изолированная утилита безопасного архивирования снимков v1 (`archiveV1Snapshot`) без автоматического неоднозначного переноса чужих данных.
3. **`src/services/storageAdapter.ts`**:
   - Класс `StorageServiceAdapter` с интерфейсом, сохраняющим обратную синхронную совместимость (`getTasks()`, `saveTask()`, и т.д.).
   - Двухуровневая архитектура: гидратированный in-memory cache + асинхронная персистентность в `IsolatedStorageEngine`.
   - Формальный жизненный цикл гидратации (`uninitialized` -> `hydrating` -> `ready` -> `error`).
   - Подписка на ошибки персистентности (`onPersistenceError`).
   - Метод переключения контекста `switchContext(newContext: StorageContext)`.
4. **Интеграция в `src/context/AuthContext.tsx`**:
   - Экспорт `storageContext: StorageContext` и `sessionGeneration: number` из `useAuth()`.
   - Управление поколениями сессий через `sessionGenerationManager`.
   - Идемпотентность выхода (`signOut`) с инвалидацией поколения.
   - Исключение инкремента поколения при техническом обновлении токена (`TOKEN_REFRESHED`), если пользователь и воркспейс не изменились.
   - Защита от гонок между `getSession()` и `onAuthStateChange`.
5. **Тестовые наборы верификации**:
   - Модульные тесты `IsolatedStorageEngine` (`OneTeamDB_v2`) и `StorageServiceAdapter`.
   - Тесты изоляции контекстов при переключении пользователей и воркспейсов.
   - Тесты отмены транзакций через `AbortSignal`.

---

## 3. Подтверждённые архитектурные решения

На основе анализа требований и памяти проекта подтверждены следующие решения:

1. **Структура `StorageContext`**:
   ```typescript
   export interface StorageContext {
     readonly userId: string | null;
     readonly workspaceId: string | null;
     readonly sessionGeneration: number;
     readonly isGuest: boolean;
   }
   ```
2. **Модель изоляции ключей в `OneTeamDB_v2`**:
   - Каждая запись физически изолирована составным ключом:
     - `workspaceId + '#' + entityId` для данных рабочего пространства;
     - `userId + '#' + entityId` для персональных данных пользователя.
   - Исключена утечка данных между воркспейсами и аккаунтами на уровне IndexedDB.
3. **Жизненный цикл `StorageServiceAdapter`**:
   - Состояния: `uninitialized` → `hydrating` → `ready` (или `error`).
   - Синхронные геттеры читают из кэша текущего активного контекста.
   - При смене контекста кэш немедленно изолируется/очищается, предотвращая cross-talk.
4. **Связка с `AbortSignal`**:
   - При инвалидации сессии или смене воркспейса вызывается `abort()`, отменяющий активные транзакции IndexedDB.
5. **Сохранение синхронного API**:
   - Сигнатуры геттеров и мутаций соответствуют ожиданиям React-компонентов и AppContext, обеспечивая zero-breaking changes при миграции.

---

## 4. Решения, требующие дополнительной проверки

1. **Стратегия отката кэша при сбоях IndexedDB (`onPersistenceError`)**:
   - Текущая спецификация эмиттит ошибку через `onPersistenceError`, оставляя решение о компенсации вызывающей стороне. Следует подтвердить, требуется ли автоматический rollback кэша при отклонении `tx`.
2. **Обработка гостевого режима (`isGuest: true`)**:
   - Использование префикса `guest#...` в `OneTeamDB_v2` либо хранение исключительно в памяти до авторизации.
3. **Синхронизация с Supabase Cloud**:
   - `cloudDataService` выполняет вызовы напрямую к Supabase; проверка прав и изоляция опираются на Supabase RLS.

---

## 5. Точный список восстанавливаемых файлов

| № | Файл | Назначение |
|---|---|---|
| 1 | `src/services/storageContext.ts` | Определение `StorageContext`, `SessionGenerationManager` |
| 2 | `src/services/indexedDbV2.ts` | Изолированное хранилище `OneTeamDB_v2` с составными ключами и AbortSignal |
| 3 | `src/services/storageAdapter.ts` | Адаптер с in-memory кэшем, синхронным API и гидратацией |
| 4 | `src/context/AuthContext.tsx` | Интеграция `sessionGenerationManager` и экспорт `storageContext` |
| 5 | `tests/foundationFixStorage.test.ts` | Тесты изоляции, переключения сессий, AbortSignal и гидратации |

---

## 6. Порядок восстановления и тестирования

1. **Шаг 1: `storageContext.ts`**:
   - Создание типов `StorageContext` и класса `SessionGenerationManager`.
   - Проверка компиляции `npm run lint`.
2. **Шаг 2: `indexedDbV2.ts`**:
   - Реализация схемы `OneTeamDB_v2`, составных ключей, привязки `AbortSignal`.
   - Архивирование снимка v1 без деструктивного вмешательства.
3. **Шаг 3: `storageAdapter.ts`**:
   - Реализация кэша, синхронных методов чтения/записи, переключения контекста, гидратации.
4. **Шаг 4: Интеграция `AuthContext.tsx`**:
   - Добавление `storageContext` и `sessionGeneration` в `AuthContextType`.
   - Обновление обработчиков аутентификации с соблюдением идемпотентности.
5. **Шаг 5: Комплексное тестирование**:
   - Написание и запуск тестов изоляции данных (`npx tsx tests/foundationFixStorage.test.ts`).
   - Проверка регрессий типов (`npm run lint`).
   - Проверка сборки (`npm run build`).

---

## 7. Критерии приёмки каждого компонента

- **StorageContext & SessionGenerationManager**:
  - Инкремент поколения при любой аутентификационной мутации или смене воркспейса.
  - Мгновенное срабатывание `AbortController.abort()`.
  - Отсутствие ложных инкрементов при `TOKEN_REFRESHED` для того же пользователя/воркспейса.
- **IndexedDbV2**:
  - Составные ключи гарантируют невозможность прочитать данные другого воркспейса/пользователя.
  - Транзакции прерываются при поступлении сигнала отмены.
- **StorageServiceAdapter**:
  - Синхронный доступ к данным без лагов интерфейса.
  - Корректная смена контекста с очисткой и гидратацией.
- **AuthContext**:
  - Экспорт актуального `storageContext`.
  - Успешное прохождение `npm run lint` и сборки.

---

## 8. Риски повторной реализации и меры их минимизации

1. **Риск расхождения сигнатур API**:
   - *Мера*: точное соответствие методам `storageService` из `src/services/storage.ts`.
2. **Риск утечки памяти из-за подписок**:
   - *Мера*: корректная отписка слушателей `onPersistenceError` и таймеров.
3. **Риск конфликта v1 и v2 в браузере**:
   - *Мера*: независимое имя базы данных `OneTeamDB_v2`, архив v1 только в read-only снимке.

---

## 9. Вердикт

**READY FOR RECOVERY IMPLEMENTATION**
(Аудит завершён, спецификация сформирована. Ожидается подтверждение пользователя перед началом создания файлов).
