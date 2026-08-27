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
