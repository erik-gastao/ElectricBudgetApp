# Plano de Atualizações — Electric Budget

Data: 2026-08-06
Base: PWA vanilla JS (sem framework/build), IndexedDB (`app/js/db.js`), wrapper
Capacitor 6 (deps em `package.json`, pasta `android/` ainda não criada).

Itens do Grupo B são **nativos** e exigem o F7 Capacitor Android materializado
(`npx cap add android`) antes de implementar.

---

## Grupo A — Web puro (funciona já no PWA)

### 1. Home: últimos 3 orçamentos
- **Decisão:** mostrar os **3** mais recentes, **abaixo** dos chips
  PENDENTES/AGUARDANDO (chips mantidos).
- Nova secção "Últimos orçamentos" em `screen-home` (`app/index.html` ~L51).
- Nova `renderHomeOrcamentos()` em `app/js/app.js` perto de `renderHomeAgenda()`
  (L730): ordena `orcamentos` por `data` desc, top 3, click → `abrirOrcDetalhe`.
- Chamar em `goTo('screen-home')` (L2060).

### 5. Criar orçamento a partir do compromisso
- Botão "Criar orçamento" em `screen-detalhe-agendamento` (`app/index.html` L368).
- Handler pré-preenche cliente do compromisso e navega `screen-orcamento`
  (padrão do `_cliReturn`). Sem schema novo.

### 8. Descrição do serviço não obrigatória
- `salvarAgendamento()` (`app/js/app.js` L847): remover `if (!desc)` (L858).
- Se vazio → salvar `desc = 'Não definido'`.
- Renders já exibem o valor (`renderAgenda` L700, `abrirDetalheAgendamento` L793).

### 11. Compromisso "concluído"
- Campo `concluido: bool` no objeto agendamento (`salvarAgendamento` L864).
- Toggle em `screen-detalhe-agendamento`.
- Estilo do estado no card (`renderAgenda` L700, `renderHomeAgenda` L753).
- Sem migração de DB (store aceita campo novo).

### 3. PDF: perguntar "abrir?" + mostrar
- Hoje `doc.save()` baixa direto (`saveOrcamento` L1630 e L446).
- Trocar por `doc.output('blob')`; modal "Abrir agora?" via `showConfirm`.
- Web: `window.open(URL.createObjectURL(blob))`.
- Android nativo: FileOpener (ver Grupo B).

### 4 + 9 + 10. Cores dos pickers + bug "definir" cortada
- Inputs `type="date"`/`type="time"` (`app/index.html` L424/L428) são nativos.
- Web: estilizar `::-webkit-calendar-picker-indicator` + `accent-color: var(--brand)`
  no `app/style.css`.
- Bug "definir" cortada: investigar `padding`/`width` de `.field-input`
  (`app/style.css` L169).
- Android: cor real do picker do SO vem do tema nativo (Grupo B).

---

## Grupo B — Nativo (exige F7 Capacitor Android)

Pré-requisito: `npx cap add android` cria a pasta `android/`; depois instalar plugins.

### 2 + 7. Contatos do celular no app
- **Decisão:** 1 via, celular → app.
- Plugin `@capacitor-community/contacts`: ler e **listar** contatos do celular
  dentro do app (tela própria de contatos).
- Botão "adicionar contato" **redireciona** para o app de contatos do celular
  (intent nativo). Ao voltar, re-render mostra o novo contato.
- Web não tem Contacts API confiável → botão só ativo no app Android.

### 6. Notificações agendadas 24h / 12h / 6h / 1h / 30min
- Hoje: `Notification` API local só dispara com app aberto
  (`dispararNotificacoesLocais` L618, só 1h antes).
- Trocar por `@capacitor/local-notifications`: ao salvar compromisso, agendar
  5 notificações (offsets 24h/12h/6h/1h/30min antes de `data`+`hora`).
- **Decisão:** ligadas por padrão em todo compromisso; toggle liga/desliga
  a qualquer momento (guardar IDs das notificações para cancelar).
- UI do toggle em `screen-detalhe-agendamento`.
- Funciona com o app fechado.

### 4 + 10 (nativo). Tema dos pickers do SO
- Após `cap add android`: `colorPrimary`/`colorAccent` no `colors.xml` + tema
  Material → pickers relógio/data herdam cores do app.
- Deve resolver "definir" cortada se for o picker nativo.

---

## Ordem de execução
1. Grupo A inteiro (entrega rápida, testável no navegador).
2. F7: `npx cap add android` + tema nativo (itens 4/9/10).
3. Plugins: local-notifications (6), contacts (2/7), FileOpener para o PDF (3 nativo).

## Notas
- Nunca criar tag `v*` / gerar APK sem pedido explícito do Erik.
