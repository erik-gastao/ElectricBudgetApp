/* ================================================================
   Patch do projeto Android gerado pelo Capacitor.

   O diretório `android/` NÃO é versionado — o CI o recria do zero a
   cada build (`npx cap add android`). Qualquer ajuste no manifest ou
   no build.gradle precisa ser reaplicado por aqui, senão some.

   Faz duas coisas:
   1. Permissões de contatos + package visibility (Android 11+), sem as
      quais `@capacitor-community/contacts` falha ao ler a agenda e o
      AppLauncher não consegue abrir o app de Contatos.
   2. Assinatura de release a partir de um keystore fixo. Sem isso o CI
      assina com o keystore de debug efêmero do runner — assinatura
      diferente a cada release, Android recusa atualizar por cima e o
      usuário precisa desinstalar, perdendo todo o IndexedDB.

   Uso: node scripts/patch-android.mjs
   ================================================================ */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const GRADLE = 'android/app/build.gradle';

/* ── 1. AndroidManifest ── */

const PERMISSOES = [
  'android.permission.READ_CONTACTS',
  'android.permission.POST_NOTIFICATIONS',
];

/* Android 11+ esconde os outros apps instalados. Sem declarar as intents
   abaixo, AppLauncher.openUrl() para contatos e WhatsApp retorna erro. */
const QUERIES = `    <queries>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:mimeType="vnd.android.cursor.dir/contact" />
        </intent>
        <intent>
            <action android:name="android.intent.action.INSERT" />
            <data android:mimeType="vnd.android.cursor.dir/contact" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
        </intent>
    </queries>
`;

function patchManifest() {
  let xml = readFileSync(MANIFEST, 'utf8');

  for (const p of PERMISSOES) {
    if (xml.includes(p)) continue;
    xml = xml.replace(
      '</manifest>',
      `    <uses-permission android:name="${p}" />\n</manifest>`
    );
  }

  if (!xml.includes('<queries>')) {
    xml = xml.replace('</manifest>', `${QUERIES}</manifest>`);
  }

  writeFileSync(MANIFEST, xml);
  console.log('✓ AndroidManifest.xml: permissões + queries aplicadas');
}

/* ── 2. Assinatura de release ── */

function patchGradle() {
  if (!existsSync('android/app/release.keystore')) {
    console.log('· release.keystore ausente — build sairá com assinatura de debug');
    return;
  }

  let gradle = readFileSync(GRADLE, 'utf8');
  if (gradle.includes('releaseKeystore')) {
    console.log('· build.gradle já assinado');
    return;
  }

  const signing = `
    signingConfigs {
        releaseKeystore {
            storeFile file('release.keystore')
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('ANDROID_KEY_ALIAS')
            keyPassword System.getenv('ANDROID_KEY_PASSWORD')
        }
    }
`;

  /* injeta signingConfigs logo após a abertura do bloco android { } */
  gradle = gradle.replace(/^android\s*\{/m, (m) => m + signing);

  /* aponta o buildType release para ele */
  gradle = gradle.replace(
    /(buildTypes\s*\{\s*release\s*\{)/,
    '$1\n            signingConfig signingConfigs.releaseKeystore'
  );

  writeFileSync(GRADLE, gradle);
  console.log('✓ build.gradle: signingConfig de release aplicada');
}

/* ── 3. versionCode / versionName a partir da tag ──
   O Capacitor gera sempre versionCode 1. Android recusa instalar por
   cima um APK com versionCode menor que o instalado, então derivamos um
   número crescente da tag (v1.2.0 → 10200). Sem tag, mantém o padrão. */

function patchVersao() {
  const ref = process.env.GITHUB_REF_NAME || '';
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(ref);
  if (!m) {
    console.log('· sem tag semver em GITHUB_REF_NAME — versão inalterada');
    return;
  }
  const [, maj, min, pat] = m.map(Number);
  const code = maj * 10000 + min * 100 + pat;
  const name = `${maj}.${min}.${pat}`;

  let gradle = readFileSync(GRADLE, 'utf8');
  gradle = gradle
    .replace(/versionCode\s+\d+/, `versionCode ${code}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${name}"`);
  writeFileSync(GRADLE, gradle);
  console.log(`✓ build.gradle: versionCode ${code} · versionName ${name}`);
}

patchManifest();
patchVersao();
patchGradle();
