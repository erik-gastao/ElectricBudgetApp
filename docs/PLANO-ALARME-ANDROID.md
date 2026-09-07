# Alarme 30 min antes do compromisso — viabilidade e plano (Android)

Data: 2026-08-26
Base: PWA vanilla JS + Capacitor 6, `@capacitor/local-notifications` 6.1.3,
projeto `android/` gerado no CI por `npx cap add android` + `scripts/patch-android.mjs`.

---

## 1. O que já existia

`_NOTIF_OFFSETS` em `app/js/app.js` já agendava 5 avisos por compromisso
(24h, 12h, 6h, 1h, **30 min**) via `LocalNotifications.schedule()`.

O que **não** existia, e é a diferença entre "notificação" e "alarme":

| Requisito de um alarme | Estado anterior |
| --- | --- |
| Disparo no minuto exato | ❌ sem `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM` no manifest, o plugin caía em `setAndAllowWhileIdle` — o Doze podia segurar por dezenas de minutos |
| Som + heads-up | ❌ tudo caía no canal padrão do Capacitor (importância média): notificação silenciosa na gaveta |
| Vibração | ❌ canal padrão, sem vibração garantida |
| Sobreviver a reboot | ✅ já vinha: `LocalNotificationRestoreReceiver` no manifest do plugin |

Confirmação no código do plugin:
`LocalNotificationManager.setExactIfPossible()` só chama
`setExactAndAllowWhileIdle()` quando `alarmManager.canScheduleExactAlarms()` é
verdadeiro — e sem permissão declarada isso é `false` a partir do Android 12.

---

## 2. Viabilidade — o que dá e o que não dá

### ✅ Viável com o plugin atual (implementado nesta entrega)

1. **Horário exato.** Declarar `SCHEDULE_EXACT_ALARM` (Android 12/12L, o
   usuário concede em *Ajustes › Alarmes e lembretes*) e `USE_EXACT_ALARM`
   (Android 13+, concedida na instalação). Feito em `scripts/patch-android.mjs`.
2. **Canal de importância máxima.** `LocalNotifications.createChannel()` com
   `importance: 5` → heads-up sobre a tela, som padrão do sistema e vibração.
   Canal `eb-alarme` só para o aviso de 30 min; `eb-lembrete` (importância 4)
   para 24h/12h/6h/1h.
3. **Pedido guiado da permissão.** `checkExactNotificationSetting()` no boot e
   `changeExactNotificationSetting()` abre a tela de Ajustes — botão
   "PERMISSÃO DE ALARME EXATO" no perfil.
4. **Fallback no PWA.** `dispararNotificacoesLocais()` agora arma `setTimeout`
   de 1h **e** de 30 min. Vale só com a aba aberta — é degradação, não solução.

### ⚠️ Não dá com este plugin (exigiria código nativo/plugin próprio)

1. **Tela cheia tocando até dispensar** (comportamento de despertador).
   Precisa de `USE_FULL_SCREEN_INTENT` + uma `Activity` própria disparada por
   `NotificationCompat.setFullScreenIntent()`. O plugin não expõe isso.
2. **Som pelo canal de ALARME** (toca mesmo no silencioso). Precisa de
   `AudioAttributes.USAGE_ALARM`; o plugin fixa `USAGE_NOTIFICATION` e só
   aplica atributos quando há som customizado em `res/raw`.
3. **Toque customizado.** `channel.sound: 'alarme'` funcionaria, mas exige um
   arquivo em `android/app/src/main/res/raw/alarme.wav` — e a pasta `raw/`ainda
   não existe, então precisaria ser criada pelo `patch-android.mjs`.

### ❌ Riscos conhecidos, fora do controle do app

- **Fabricantes com otimização agressiva** (Xiaomi/MIUI, Huawei, Samsung
  "Sono profundo"): mesmo com alarme exato, o app precisa estar na lista de
  "não otimizar bateria". Isto é uma ação manual do usuário.
- **Play Store e `USE_EXACT_ALARM`:** a política só aceita essa permissão em
  apps de alarme/agenda. A distribuição aqui é APK direto (release do GitHub),
  então não bloqueia nada. Se um dia for pra Play e for recusada, basta remover
  a linha do `patch-android.mjs` — `SCHEDULE_EXACT_ALARM` continua cobrindo.

---

## 3. O que foi implementado agora

| Arquivo | Mudança |
| --- | --- |
| `scripts/patch-android.mjs` | `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM`, `VIBRATE` no manifest |
| `app/js/app.js` | `CANAL_ALARME`/`CANAL_LEMBRETE`, `criarCanaisNotif()`, `channelId` por offset, `checarAlarmeExato()`, `abrirAjustesAlarmeExato()`, `avisarSeAlarmeInexato()` |
| `app/js/app.js` | fallback PWA de 30 min em `dispararNotificacoesLocais()` |
| `app/index.html` | secção "ALARME DA AGENDA" no perfil com o botão da permissão |

Fluxo no boot (`reagendarTodasNotificacoes`):
`criarCanaisNotif()` → `garantirPermissaoNotif()` → reagenda todos os
compromissos → `avisarSeAlarmeInexato()` (pergunta uma vez por sessão se a
permissão de alarme exato estiver negada).

---

## 4. Próximos passos (se quiser alarme "de despertador")

Ordem de custo crescente:

1. **Toque próprio (baixo).** Adicionar `alarme.wav` em `res/raw` via
   `patch-android.mjs` e passar `sound: 'alarme'` no canal `eb-alarme`.
   Atenção: trocar o som exige **id de canal novo** (ex.: `eb-alarme-v2`) —
   canal já criado é imutável.
2. **Ação "adiar 10 min" (médio).** `LocalNotifications.registerActionTypes()`
   + listener `localNotificationActionPerformed` reagendando o mesmo id.
   Só JS, sem código nativo.
3. **Tela cheia com som contínuo (alto).** Plugin Capacitor próprio em Kotlin:
   `AlarmActivity` + `setFullScreenIntent()` + `USE_FULL_SCREEN_INTENT` +
   `MediaPlayer` no stream de alarme. Substitui o `@capacitor/local-notifications`
   para o offset de 30 min; os outros quatro continuam no plugin.

## 5. Como validar no aparelho

1. `git tag vX.Y.Z && git push --tags` → o workflow `apk.yml` gera o APK.
2. Instalar, abrir o app, aceitar a notificação e (Android 12) o pedido de
   alarmes e lembretes.
3. Criar um compromisso para **daqui a ~35 min**, fechar o app (deslizar da
   lista de recentes) e deixar a tela apagada.
4. Esperado: aos 30 min restantes, heads-up "⏰ Compromisso em 30 minutos"
   com som e vibração, com margem de erro de segundos.
5. Se atrasar muito: conferir *Ajustes › Apps › Electric Budget › Bateria →
   Sem restrições* e *Alarmes e lembretes → permitido*.

---

# Parte 2 — Alarme "de despertador" e o app de lembretes da Samsung

Data: 2026-09-06
Contexto: o aviso de 30 min já sai no minuto exato, com heads-up, som e
vibração (Parte 1). O que ainda não acontece é o comportamento de
**despertador**: tocar até alguém dispensar, por cima do bloqueio de tela,
no volume de alarme (ou seja, mesmo com o celular no silencioso).

---

## 6. As quatro rotas possíveis

### Rota A — Alarme de verdade dentro do app (plugin próprio em Kotlin)

Notificação com `setFullScreenIntent()` + uma `AlarmActivity` que sobe sobre
o bloqueio de tela e toca `MediaPlayer` no stream `USAGE_ALARM` até o botão
DISPENSAR / ADIAR 10 MIN.

- **Precisa de:** `USE_FULL_SCREEN_INTENT` (Android 14+ pede concessão do
  usuário para apps que não são de alarme/chamada), `WAKE_LOCK`,
  `setShowWhenLocked(true)` / `setTurnScreenOn(true)` na Activity, canal de
  notificação novo (`eb-alarme-v2` — canal já criado é imutável).
- **Custo:** ~200 linhas de Kotlin (`AlarmActivity` + plugin `@CapacitorPlugin`
  + layout) mais a injeção no `scripts/patch-android.mjs` (a pasta `android/`
  não é versionada: o CI a recria a cada build, então o arquivo Kotlin, o
  layout e o `registerPlugin()` no `MainActivity` têm que ser escritos por lá).
- **Ganho:** controle total. Toca no volume de alarme, sobe na tela de
  bloqueio, tem "adiar 10 min", funciona sem depender de nenhum app da Samsung.
- **Risco:** é o único item da lista que exige manter código nativo.

### Rota B — Delegar ao app de Relógio do aparelho (`ACTION_SET_ALARM`)

`android.provider.AlarmClock.ACTION_SET_ALARM` é intent **padrão do Android**,
implementada pelo Relógio da Samsung que já vem no S23. Cria um alarme de
verdade na lista de alarmes do celular — mesmo som, mesma tela, mesmo
snooze do despertador que o Erik já usa de manhã.

- **Precisa de:** permissão `com.android.alarm.permission.SET_ALARM`
  (install-time, sem prompt) e um shim nativo de ~25 linhas para disparar a
  intent com extras — `@capacitor/app-launcher` só faz `openUrl`, não monta
  `Intent` com extras, e o WebView do Capacitor não resolve URLs `intent://`.
- **Extras:** `EXTRA_HOUR`, `EXTRA_MINUTES`, `EXTRA_MESSAGE`
  (ex.: "Compromisso: troca de disjuntor — Maria"), `EXTRA_SKIP_UI = true`
  (cria sem abrir a tela do Relógio), `EXTRA_VIBRATE`.
- **Limitação dura:** `ACTION_SET_ALARM` **não aceita data**, só hora e
  minuto — o alarme dispara na próxima ocorrência daquele horário. Serve
  para compromisso dentro das próximas 24 h; para o de terça que vem, não.
- **Ganho:** custo baixíssimo, comportamento de despertador de graça, e o
  alarme fica visível/editável no app de Relógio do celular.
- **Risco:** cada alarme criado é um alarme na lista do usuário — precisa de
  uma regra clara de quando criar (ver §7) para não poluir o Relógio.

### Rota C — Samsung Reminder (`com.samsung.android.app.reminder`)

O app Reminder do S23 **não publica intent documentada** de criação. Existem
actions internas usadas pelo Bixby e pelo próprio sistema, mas não fazem
parte de nenhuma API pública: mudam entre versões do One UI, podem exigir
assinatura Samsung e quebrariam sem aviso numa atualização do sistema.

- **Veredito:** não recomendado como caminho principal. O substituto
  suportado é a Rota D (evento no Calendário, que a Samsung sincroniza) ou a
  Rota B (Relógio, que é API padrão do Android).

### Rota D — Evento no Calendário via `CalendarContract`

`Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)` abre o
Calendário (Samsung ou Google) já preenchido, e o usuário confirma. Com
`CalendarContract.Reminders` dá para pedir o aviso de 30 min antes.

- **Ganho:** o compromisso passa a existir fora do app — aparece no
  calendário do celular, no relógio de pulso, no widget.
- **Custo:** também precisa do shim nativo (é uma intent com extras).
- **Limitação:** o aviso do calendário é notificação, **não** despertador.
  Complementa a Rota A/B, não substitui.

---

## 7. Recomendação

**Rota B agora, Rota A depois se ainda faltar.** Justificativa:

1. A Rota B resolve exatamente a queixa — "quero um alarme, não um aviso" —
   com um shim nativo de ~25 linhas contra ~200 da Rota A, e sem nenhum
   risco de política de Play Store.
2. O aviso exato de 30 min já implementado (Parte 1) continua sendo a rede
   de segurança para os compromissos além de 24 h, onde a Rota B não alcança.
3. Se depois de usar ficar claro que ter o alarme dentro do app vale o
   código nativo (tela cheia com o nome do cliente, "adiar 10 min" que
   reagenda o compromisso), a Rota A entra sem desfazer nada da B.

### Regra de criação proposta (Rota B)

| Quando | O que acontece |
| --- | --- |
| Compromisso salvo para **hoje ou amanhã**, com mais de 30 min de antecedência | botão "⏰ ALARME NO RELÓGIO" fica ativo no detalhe do compromisso |
| Erik toca o botão | cria o alarme no Relógio para `hora − 30 min`, com `EXTRA_MESSAGE` = descrição + cliente |
| Compromisso além de 24 h | botão desativado, com a explicação "o Relógio do Android só guarda hora, não data — o aviso de 30 min continua valendo" |

Criação **manual** (botão) e não automática de propósito: alarme criado sem
o usuário pedir vira alarme que ele não sabe de onde veio nem como apagar.

---

## 8. Plano de implementação da Rota B — **IMPLEMENTADA em 06/09/2026**

Todos os itens da tabela abaixo estão feitos; falta só validar no aparelho
(a seção "Como validar" continua sendo o roteiro).

| # | Arquivo | Mudança |
| --- | --- | --- |
| 1 | `scripts/patch-android.mjs` | acrescentar `com.android.alarm.permission.SET_ALARM` à lista `PERMISSOES` |
| 2 | `scripts/patch-android.mjs` | escrever `android/app/src/main/java/<pkg>/EbRelogioPlugin.kt` (o diretório `android/` é recriado a cada build do CI) |
| 3 | `scripts/patch-android.mjs` | injetar `registerPlugin(EbRelogioPlugin::class.java)` no `MainActivity` |
| 4 | `app/js/app.js` | `pluginRelogio()` no mesmo padrão de `pluginLN()`/`pluginContacts()`; `criarAlarmeRelogio(ag)` calculando `hora − 30 min`; `podeAlarmeRelogio(ag)` (dentro de 24 h e no futuro) |
| 5 | `app/index.html` | botão "⏰ ALARME NO RELÓGIO" em `screen-detalhe-agendamento`, ao lado do toggle de notificações |
| 6 | `app/js/app.js` | `diagPlugins()` passa a reportar o plugin novo (o diagnóstico é como se descobre plugin faltando no APK) |
| 7 | `app/sw.js` | bump do `CACHE` (v20) |

O plugin foi escrito em **Java**, não em Kotlin: o projeto que o
`npx cap add android` gera não aplica o plugin Kotlin do Gradle, e um `.kt`
solto não compilaria. O `patch-android.mjs` cria
`EbRelogioPlugin.java`, injeta o `registerPlugin()` no `MainActivity.java`
(antes do `super.onCreate()`, senão a bridge sobe sem o plugin) e acrescenta
`<intent><action android:name="android.intent.action.SET_ALARM" /></intent>`
ao bloco `<queries>` — sem isso o `resolveActivity()` volta `null` no
Android 11+ mesmo com o Relógio instalado. Rodar o script duas vezes é
seguro: cada patch verifica antes de escrever.

Esqueleto do plugin (Kotlin):

```kotlin
@CapacitorPlugin(name = "EbRelogio")
class EbRelogioPlugin : Plugin() {
  @PluginMethod
  fun criarAlarme(call: PluginCall) {
    val hora = call.getInt("hora") ?: return call.reject("hora obrigatória")
    val minuto = call.getInt("minuto") ?: 0
    val titulo = call.getString("titulo") ?: "Compromisso"
    val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
      putExtra(AlarmClock.EXTRA_HOUR, hora)
      putExtra(AlarmClock.EXTRA_MINUTES, minuto)
      putExtra(AlarmClock.EXTRA_MESSAGE, titulo)
      putExtra(AlarmClock.EXTRA_VIBRATE, true)
      putExtra(AlarmClock.EXTRA_SKIP_UI, call.getBoolean("semUi") ?: true)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    if (intent.resolveActivity(context.packageManager) == null) {
      return call.reject("nenhum app de relógio disponível")
    }
    context.startActivity(intent)
    call.resolve()
  }
}
```

### Como validar no aparelho

1. Criar um compromisso para daqui a ~40 min.
2. No detalhe, tocar "⏰ ALARME NO RELÓGIO" → toast de confirmação.
3. Abrir o app **Relógio** da Samsung: o alarme deve estar lá, no horário
   `compromisso − 30 min`, com o nome do serviço no rótulo.
4. Colocar o celular no **silencioso** e esperar: alarme de despertador tem
   que tocar assim mesmo (é o comportamento do Relógio, não do app).
5. Compromisso para daqui a 3 dias: o botão deve aparecer **desativado**,
   com a explicação — e a notificação exata de 30 min continua agendada.

### Custo estimado

| Rota | Kotlin | JS/HTML | Total |
| --- | --- | --- | --- |
| B (Relógio do sistema) | ~25 linhas | ~60 linhas | meia tarde |
| A (despertador próprio) | ~200 linhas + layout | ~40 linhas | 1–2 dias, com teste em aparelho |
