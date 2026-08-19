/* ================================================================
   Patch do projeto Android gerado pelo Capacitor.

   O diretório `android/` NÃO é versionado — o CI o recria do zero a
   cada build (`npx cap add android`). Qualquer ajuste no manifest ou
   no build.gradle precisa ser reaplicado por aqui, senão some.

   Faz três coisas:
   1. Permissões (contatos, notificações, armazenamento) + package
      visibility (Android 11+), sem as quais `@capacitor-community/contacts`
      falha ao ler a agenda, o AppLauncher não abre o app de Contatos e o
      FileOpener não acha nenhum leitor de PDF.
   2. Raízes do FileProvider em file_paths.xml, sem as quais entregar o
      PDF por content:// lança IllegalArgumentException.
   3. Assinatura de release a partir de um keystore fixo. Sem isso o CI
      assina com o keystore de debug efêmero do runner — assinatura
      diferente a cada release, Android recusa atualizar por cima e o
      usuário precisa desinstalar, perdendo todo o IndexedDB.

   Uso: node scripts/patch-android.mjs
   ================================================================ */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const GRADLE = 'android/app/build.gradle';

/* ── 1. AndroidManifest ── */

/* WRITE_CONTACTS está aqui mesmo o app nunca escrevendo na agenda (criar
   contato é delegado ao app de Contatos via AppLauncher). O alias
   `contacts` do @capacitor-community/contacts cobre READ + WRITE, e o
   Capacitor recusa requestPermissions() se qualquer permissão do alias
   faltar no manifest — com só READ declarado, a chamada lançava
   "Missing the following permissions in AndroidManifest.xml:
   android.permission.WRITE_CONTACTS" e o sync morria antes do prompt.
   As duas caem no mesmo grupo de permissão do Android, então o usuário
   continua vendo um único pedido de acesso aos contatos. */
const PERMISSOES = [
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.POST_NOTIFICATIONS',
];

/* Escrita na pasta pública Documentos. Da API 30 em diante o app já pode
   criar seus próprios arquivos lá sem permissão nenhuma, então o teto vai
   até 29 (o último Android que ainda exige a permissão, junto com o
   requestLegacyExternalStorage acima).

   O teto importa nos dois sentidos: sem ele o Android novo pediria acesso
   ao armazenamento à toa; e se fosse baixo demais (28), o Android 10
   ficaria com a permissão removida na instalação e o Capacitor recusaria
   requestPermissions() com "Missing the following permissions in
   AndroidManifest.xml" — o mesmo tropeço que o alias de contatos deu. */
const PERMISSOES_MAXSDK = [
  ['android.permission.WRITE_EXTERNAL_STORAGE', 29],
  ['android.permission.READ_EXTERNAL_STORAGE', 32],
];

/* Android 11+ esconde os outros apps instalados. Sem declarar as intents
   abaixo, AppLauncher.openUrl() para contatos e WhatsApp retorna erro, e
   o FileOpener não encontra nenhum leitor de PDF (o Intent volta como
   "activity not found" mesmo com o app instalado). */
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
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:mimeType="application/pdf" />
        </intent>
        <intent>
            <action android:name="android.intent.action.SEND" />
            <data android:mimeType="application/pdf" />
        </intent>
    </queries>
`;

function patchManifest() {
  let xml = readFileSync(MANIFEST, 'utf8');

  /* Android 10 (API 29) é o único que exige o opt-out do armazenamento
     com escopo pra deixar o Filesystem escrever na pasta pública
     Documentos. Ignorado da API 30 em diante — lá o app já pode criar
     seus próprios arquivos lá. Sem isso, no Android 10, salvar o PDF em
     DOCUMENTS falha e cai pro diretório do app. */
  if (!xml.includes('requestLegacyExternalStorage')) {
    xml = xml.replace(
      '<application',
      '<application\n        android:requestLegacyExternalStorage="true"'
    );
  }

  for (const p of PERMISSOES) {
    if (xml.includes(p)) continue;
    xml = xml.replace(
      '</manifest>',
      `    <uses-permission android:name="${p}" />\n</manifest>`
    );
  }

  for (const [p, maxSdk] of PERMISSOES_MAXSDK) {
    if (xml.includes(p)) continue;
    xml = xml.replace(
      '</manifest>',
      `    <uses-permission android:name="${p}" android:maxSdkVersion="${maxSdk}" />\n</manifest>`
    );
  }

  if (!xml.includes('<queries>')) {
    xml = xml.replace('</manifest>', `${QUERIES}</manifest>`);
  }

  writeFileSync(MANIFEST, xml);
  console.log('✓ AndroidManifest.xml: permissões + queries aplicadas');
}

/* ── 2. FileProvider ──
   O FileOpener/Share entrega o PDF por content:// via FileProvider. O
   file_paths.xml que o Capacitor gera só declara external-path e
   cache-path; se o Filesystem gravar no armazenamento interno do app
   (fallback), o provider não sabe mapear o caminho e o open explode com
   IllegalArgumentException. Declara todas as raízes de uma vez. */

const FILE_PATHS = 'android/app/src/main/res/xml/file_paths.xml';

const RAIZES = [
  ['files-path',          'app_files'],
  ['cache-path',          'app_cache'],
  ['external-path',       'external'],
  ['external-files-path', 'external_files'],
  ['external-cache-path', 'external_cache'],
  ['external-media-path', 'external_media'],
];

function patchFilePaths() {
  if (!existsSync(FILE_PATHS)) {
    console.log('· file_paths.xml ausente — nada a fazer');
    return;
  }
  let xml = readFileSync(FILE_PATHS, 'utf8');
  let mudou = false;

  for (const [tag, name] of RAIZES) {
    if (xml.includes(`<${tag} `)) continue;
    xml = xml.replace('</paths>', `    <${tag} name="${name}" path="." />\n</paths>`);
    mudou = true;
  }

  if (!mudou) {
    console.log('· file_paths.xml já cobre todas as raízes');
    return;
  }
  writeFileSync(FILE_PATHS, xml);
  console.log('✓ file_paths.xml: raízes do FileProvider completas');
}

/* ── 3. Assinatura de release ── */

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

/* ── 4. versionCode / versionName a partir da tag ──
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
patchFilePaths();
patchVersao();
patchGradle();
