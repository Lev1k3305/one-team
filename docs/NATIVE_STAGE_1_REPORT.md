# ONE TEAM — Отчёт об интеграции Capacitor 8 (Native Stage 1)

> **Статус:** Выполнено успешно
> **Ветка:** `feat/native-stage-1-capacitor`
> **Базовый коммит:** `2def226`
> **Дата выполнения:** 06 ноября 2026

---

## 1. Введение и цели этапа

Целью этапа **Native Stage 1** являлась полноценная интеграция Capacitor 8 в существующую кодовую базу ONE TEAM без изменений бизнес-логики, схем Supabase, RLS, миграций и Edge Functions.

### Исходные параметры:
- **Capacitor Version:** `8.6.0` (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/ios`, `@capacitor/app: 8.1.2`)
- **Application ID (appId):** `kz.oneteam.app`
- **Application Name (appName):** `ONE TEAM`
- **Web Build Directory (webDir):** `dist`
- **Background Color:** `#0B0F19`
- **Deep Link Scheme:** `oneteam://`

---

## 2. Реализованные изменения

### 2.1 Обновление зависимостей и esbuild
- В `package.json` обновлена dev-зависимость `esbuild` с `^0.25.0` до `^0.28.0`.
- Запущен стандартный `npm install` (без флагов `--legacy-peer-deps` и `--force`), разрешивший зависимости и актуализировавший `package-lock.json`.
- Установлены пакеты Capacitor 8:
  - `@capacitor/core`: `^8.6.0`
  - `@capacitor/cli`: `^8.6.0`
  - `@capacitor/android`: `^8.6.0`
  - `@capacitor/ios`: `^8.6.0`
  - `@capacitor/app`: `^8.1.2`

### 2.2 Конфигурация Capacitor (`capacitor.config.ts`)
Создан конфигурационный файл со следующими параметрами:
```typescript
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kz.oneteam.app',
  appName: 'ONE TEAM',
  webDir: 'dist',
  backgroundColor: '#0B0F19',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
};

export default config;
```

### 2.3 Добавление npm-скриптов
В `package.json` добавлены скрипты жизненного цикла Capacitor:
```json
"cap:sync": "cap sync",
"cap:copy": "cap copy",
"cap:build": "npm run build && cap sync",
"cap:android": "cap open android",
"cap:ios": "cap open ios"
```

### 2.4 Генерация нативных проектов
- Сгенерирован нативный Android проект: директория `android/` с Gradle-проектом, `MainActivity.java`, иконками и сплеш-экранами.
- Сгенерирован нативный iOS проект: директория `ios/` со структурой Xcode (`App.xcodeproj`, `Info.plist`, `AppDelegate.swift`, SPM `Package.swift`).

### 2.5 Настройка Deep Links (`oneteam://`)
1. **Android (`android/app/src/main/AndroidManifest.xml`):**
   Добавлен `intent-filter` для схемы `oneteam`:
   ```xml
   <intent-filter>
       <action android:name="android.intent.action.VIEW" />
       <category android:name="android.intent.category.DEFAULT" />
       <category android:name="android.intent.category.BROWSABLE" />
       <data android:scheme="oneteam" />
   </intent-filter>
   ```

2. **iOS (`ios/App/App/Info.plist`):**
   Добавлен словарь `CFBundleURLTypes` для регистрации схемы `oneteam`:
   ```xml
   <key>CFBundleURLTypes</key>
   <array>
       <dict>
           <key>CFBundleURLName</key>
           <string>kz.oneteam.app</string>
           <key>CFBundleURLSchemes</key>
           <array>
               <string>oneteam</string>
           </array>
       </dict>
   </array>
   ```

### 2.6 Изоляция Service Worker в Native Runtime
В `src/main.tsx` Service Worker изолирован с помощью `@capacitor/core`:
```typescript
import { Capacitor } from '@capacitor/core';

// Register Service Worker for PWA with update detection and safe activation only in Web/PWA
if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  ...
}
```
В нативном рантайме (Android/iOS WebView) Service Worker теперь отключен, исключая дублирование кэша и ошибки в схемах `capacitor://` и `https://localhost`. При этом PWA функционал для браузера сохранён в неизменном виде.

### 2.7 Поддержка Supabase Auth Deep Linking
Создан модуль `src/services/native/deepLinkService.ts` и подключен в `src/App.tsx`.
Слушатель `CapApp.addListener('appUrlOpen')`:
- Перехватывает URL схемы `oneteam://`.
- Обрабатывает токены авторизации в hash (`#access_token=...&refresh_token=...`) через `supabase.auth.setSession(...)`.
- Обрабатывает OAuth PKCE / OTP коды в query (`?code=...`) через `supabase.auth.exchangeCodeForSession(code)`.
- Поддерживает ссылки сброса пароля (`type=recovery` / `reset-password`).

---

## 3. Результаты сборки и верификации

### 3.1 Статический анализ TypeScript
- Команда: `npm run lint` (`tsc --noEmit`)
- Результат: **0 ошибок (код завершения 0)**.

### 3.2 Автоматизированные тесты
1. **Local-First & Storage Test Suite (`tests/localFirst.test.ts`):**
   - Результат: **9 из 9 тестов пройдены успешно**.
2. **iPad & Tablet Responsive Suite (`tests/tabletResponsive.test.ts`):**
   - Проверено 12 вьюпортов (iPad Mini Portrait/Landscape, iPad Air Portrait/Landscape, iPad Pro 11 Portrait/Landscape, iPad Pro 13 Portrait/Landscape, Android Tablet Portrait/Landscape, Smartphone 390px, Desktop 1440px).
   - Результат: **Все 12 вьюпортов успешно пройдены**, сохранены скриншоты в `screenshots/`.

### 3.3 Продакшн Web Build и Sync
- Команда: `npm run build && npm run cap:sync`
- Сборка Vite в `dist/` завершена успешно:
  - `dist/index.html` (2.30 kB)
  - `dist/assets/index-JDJFYMGj.css` (103.60 kB)
  - `dist/assets/index-C8vQU3pV.js` (906.01 kB)
- Ассеты и конфигурация успешно синхронизированы в `android/` и `ios/`.

### 3.4 Android Debug Build & Tests
- Команда сборки: `cd android && ./gradlew assembleDebug`
- Настройки сети Gradle: добавлен флаг `-Djava.net.preferIPv4Stack=true` в `android/gradle.properties` для стабильной загрузки артефактов в среде Linux.
- Статус сборки: **BUILD SUCCESSFUL (123 actionable tasks: 118 executed, 5 up-to-date)**.
- **Путь к собранному APK:**
  `android/app/build/outputs/apk/debug/app-debug.apk`
- Размер APK: **9.0 MB**
- **Android Unit Tests:** Команда `./gradlew testDebugUnitTest` успешно выполнена (**BUILD SUCCESSFUL**, 69 tasks, package `kz.oneteam.app`).
- **Android Instrumented Tests:** `ExampleInstrumentedTest.java` обновлён: package `kz.oneteam.app`, проверка `assertEquals("kz.oneteam.app", appContext.getPackageName())`. Тестовый APK `app-debug-androidTest.apk` успешно собран. Запуск нативного прогона на эмуляторе/устройстве (`./gradlew connectedAndroidTest`) требует физически подключённого Android устройства или запущенного AVD эмулятора (`adb devices` в Linux sandbox вернул пустой список устройств).

### 3.5 Статус сборки под iOS
- **Ограничение среды:** Текущее рабочее окружение развёрнуто на базе Linux x86_64 (`Ubuntu 24.04 LTS`).
- Инструмент `xcodebuild` и среда macOS недоступны в данной операционной системе (`which xcodebuild` возвращает отсутствие исполняемого файла).
- Проект Xcode (`ios/App/App.xcodeproj`) и схема Swift Package Manager (`Package.swift`) сгенерированы в полной готовности к открытию в Xcode 16+ на macOS (`npm run cap:ios` / `npx cap open ios`).

---

## 4. Перечень изменённых и созданных файлов

### Новые файлы:
- `capacitor.config.ts` — корневой конфигурационный файл Capacitor.
- `src/services/native/deepLinkService.ts` — сервис обработки нативных Deep Links.
- `docs/NATIVE_STAGE_1_REPORT.md` — данный отчёт.
- `android/` — нативный Android-проект со всеми сопутствующими файлами Gradle и манифестом.
- `ios/` — нативный iOS-проект для Xcode.

### Изменённые файлы:
- `package.json` — обновление esbuild до `^0.28.0`, добавление зависимостей `@capacitor/*`, добавление `cap:*` скриптов.
- `package-lock.json` — обновлено стандартным npm install.
- `src/main.tsx` — проверка `!Capacitor.isNativePlatform()` для изоляции Service Worker.
- `src/App.tsx` — инициализация `setupNativeDeepLinks()` при монтировании.
- `android/app/src/main/AndroidManifest.xml` — интент-фильтр для `oneteam://`.
- `android/gradle.properties` — флаг IPv4 для Gradle.
- `ios/App/App/Info.plist` — регистрация `CFBundleURLTypes` со схемой `oneteam`.
