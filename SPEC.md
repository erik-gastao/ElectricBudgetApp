# Electric Budget — Especificação para Construção do App

> **Para o modelo que vai construir:** este documento descreve o app que deve ser produzido.
> Um protótipo funcional já existe em `prototipo-referencia/` — use-o como fonte de verdade
> para layout, fluxos, dados de exemplo e regras. Ele **não** é o produto final: é uma maquete
> visual sem persistência. Sua tarefa é transformá-lo em app mobile real.

---

## 1. Contexto e objetivo

App mobile para **eletricistas autônomos** gerenciarem o negócio de campo:
orçamentos, agenda, clientes, materiais e pagamentos. Substitui planilhas manuais.

- **Usuário:** eletricista autônomo, uso em campo (celular na mão, às vezes sem internet).
- **Idioma:** português brasil. Moeda `R$` formato BR (`R$ 1.320,00`).
- **Projeto de portfólio** do Erik Gastão Tavares (autor do protótipo, junto com Ana Luisa).

O app deve **parecer e funcionar como app nativo**: instalável, offline, com persistência
real dos dados. Hoje o protótipo perde tudo ao recarregar — isso é o gap #1 a resolver.

---

## 2. Stack recomendada

Decisão-chave: **reaproveitar o máximo do protótipo** (HTML/CSS/JS já validado em IHC).

### Caminho recomendado: PWA → Capacitor (2 fases)

**Fase A — PWA (Progressive Web App)**
- Mantém HTML/CSS/JS existente.
- Adiciona: `manifest.json`, service worker (offline/cache), ícones.
- Persistência: **IndexedDB** (via biblioteca leve como `idb` ou `localForage`) — não usar
  `localStorage` para dados relacionais, só para preferências simples.
- Resultado: instalável pelo navegador ("Adicionar à tela inicial"), funciona offline.
- Esforço: baixo. Reaproveita ~100% do código.

**Fase B — Capacitor (empacotar como app nativo)**
- Envolve a PWA num shell nativo (Capacitor da Ionic).
- Ganha: câmera, geração de PDF real, notificações push, publicação na Play Store.
- Reaproveita ~90% do código web.

### Alternativas (se o autor preferir reescrever)
- **React Native / Expo (JS/TS)** — nativo real, reescreve a UI mas reusa a lógica.
- **.NET MAUI (C#)** — o autor já conhece C#; nativo, mas reescreve tudo.
- **Flutter (Dart)** — melhor UI/perf, porém linguagem nova e descarta o protótipo.

> **Recomendação:** comece pela **Fase A (PWA)**. É o menor caminho até um app real e
> funcional para portfólio, e não fecha portas — Capacitor entra depois sem retrabalho.

---

## 3. Estado atual do protótipo (o que reusar)

Arquivos em `prototipo-referencia/`:

| Arquivo | Linhas | Papel |
|---------|--------|-------|
| `index.html` | 863 | 12+ telas `.screen` dentro de uma `.phone` (375px) |
| `style.css` | 887 | design system completo — **reusar integralmente** |
| `script.js` | 735 | lógica de UI, render, validações, cálculo de totais |
| `screenshots/` | 9 img | referência visual de cada tela |
| `README.md` | — | doc de IHC, design e telas |

**Arquitetura atual:** single-page. Navegação por `goTo(id)` que troca a classe `.active`
entre telas. Dados em arrays JS em memória (`pagamentos`, `agendamentos`, `materiais`,
`orcamentoAtual`, `orcamentosSalvos`). Render manual via `innerHTML`.

**Reusar:** todo o CSS, a estrutura de telas, os fluxos, as validações, os dados-exemplo,
a lógica de cálculo de totais.

**Refatorar:** camada de dados (memória → IndexedDB), e idealmente extrair a montagem de
HTML por string para um render mais sustentável (opcional na Fase A).

---

## 4. Modelo de domínio

Cinco entidades. Tipos monetários **sempre decimais com 2 casas** — nunca float impreciso
para exibição; formatar em BR.

> ⚠️ **ATENÇÃO — este modelo é o ALVO, não o estado atual do protótipo.** O protótipo é
> maquete e ainda **não** implementa esta estrutura. Diferenças reais a migrar:
> - Nenhuma entidade tem `id` no protótipo (`pagamentos` script.js:31, `agendamentos` :125,
>   `materiais` :326). Você deve **adicionar `id` a todas** (ver §7.6 e §4.1).
> - `Pagamento` e `Agendamento` referenciam cliente por **string `cliente`**, não `clienteId`.
>   Migrar: criar clientes de verdade e religar por `clienteId`.
> - `orcamentosSalvos.push()` (script.js:459) grava só `{ cliente, total, status, data }` e
>   **descarta os itens** (`materiais`/`maoDeObra`). O alvo abaixo persiste os itens — sem eles
>   o total não pode ser revalidado (§4/§8). Persistir o array completo.
> Trate os shapes abaixo como destino da migração da F1, não como algo que já existe.

### 4.1 Geração de IDs (regra fixa)

Todo `id` é **string UUID** gerada por `crypto.randomUUID()` no momento da criação da entidade
(disponível em todo browser moderno e no Capacitor). Nunca usar índice de array como identidade
(frágil — ver §7.6). Uma vez atribuído, `id` é imutável e é a chave do object store (§4.2).
Referências entre entidades (`clienteId`, `materialId`) guardam esse UUID.

### Cliente
```
{ id, nome, telefone, endereco, email? }
```
Iniciais do nome geram avatar (2 primeiras palavras).

### Material
```
{ id, nome, unit: 'metro'|'unidade'|'pacote'|'kg'|'rolo', preco: number, cat: 'FIOS'|'DISJUNTORES'|'TOMADAS'|'OUTROS' }
```

### Orcamento
```
{ id, clienteId, data, status: 'rascunho'|'enviado'|'aprovado'|'recusado', materiais: [ItemMaterial], maoDeObra: [ItemMob], total }
ItemMaterial = { materialId, nome, unit, preco, qty }
ItemMob      = { nome, valor }
```
**Regra crítica:** `total` = soma(materiais.preco × qty) + soma(maoDeObra.valor).
Nunca persistir um total calculado por fora sem revalidar os itens (risco de dessincronização).

### Agendamento
```
{ id, data: 'YYYY-MM-DD', hora: 'HH:MM', desc, cliente, obs? }
```

### Pagamento
```
{ id, clienteId, orcamentoId?, servico, valor, status: 'pendente'|'pago', forma: 'PIX'|'BOLETO'|'CARTÃO', dataVencimento, dataPagamento? }
```
`status` **persistido** é só `pendente`|`pago`. `atrasado` **não é salvo** — é derivado
(`pendente` && `dataVencimento < hoje`), calculado no render (§8.1). `orcamentoId` presente
quando o pagamento nasceu da aprovação de um orçamento; `dataPagamento` preenchida ao marcar pago.

Dados-exemplo reais para seed estão no topo de `script.js`: `pagamentos` (31-35),
`agendamentos` (125-130), `materiais` (326-334). **Nenhum traz `id` nem `clienteId`** — o seed
da F1 deve gerar `id` (§4.1) e resolver clientes para `clienteId` ao inserir.

### 4.2 Schema IndexedDB (contrato da F1)

Um banco `electricbudget`, versão `1`. Cinco object stores, `keyPath: 'id'`, `autoIncrement:
false` (id vem do `crypto.randomUUID()`). Índices para as consultas que as telas fazem:

| Store | keyPath | Índices |
|-------|---------|---------|
| `clientes` | `id` | `nome` |
| `materiais` | `id` | `cat`, `nome` |
| `orcamentos` | `id` | `clienteId`, `status`, `data` |
| `agendamentos` | `id` | `data` (consulta por dia/mês da agenda) |
| `pagamentos` | `id` | `clienteId`, `status`, `data` (filtro status + "este mês") |

Store separado `preferencias` (ou `localStorage`) para config não-relacional (toggles do §5
perfil-eletricista). Toda escrita numa transação `readwrite`; re-hidratar todos os stores na
abertura do app antes do primeiro render. Migrações futuras: bump de `version` + `onupgradeneeded`.

**Seed idempotente:** semear os dados-exemplo **apenas se o store estiver vazio**
(`count() === 0`). Nunca semear incondicionalmente — em IndexedDB (persistente) isso duplicaria
os registros a cada abertura. Sem flag: a checagem "store vazio?" já é a garantia.

---

## 5. Telas (16)

| ID | Título | Acesso | Função |
|----|--------|--------|--------|
| `screen-home` | Dashboard | inicial | agenda do dia, pagamentos a receber, busca global, atalhos |
| `screen-pagamentos` | Pagamentos | home | lista filtrável (status/mês), registrar pagamento |
| `screen-clientes` | Clientes | home | lista, busca |
| `screen-perfil-cliente` | Perfil Cliente | lista clientes | dados + financeiro do cliente |
| `screen-novo-cliente` | Novo Cliente | clientes / orçamento | cadastro |
| `screen-materiais` | Materiais | home | lista com busca + filtro por categoria |
| `screen-novo-material` | Novo/Editar Material | materiais | cadastro/edição (form reaproveitado) |
| `screen-orcamento` | Novo Orçamento | home / FAB | montar orçamento: materiais + mão de obra, totais automáticos |
| `screen-picker-material` | Selecionar Material | orçamento | picker com qtd + ADD |
| `screen-orcamento-detalhe` | Detalhe Orçamento | perfil cliente | ação contextual muda por status |
| `screen-agenda` | Agenda | home | calendário mensal interativo + lista por dia |
| `screen-novo-agendamento` | Novo/Editar Agendamento | agenda | cadastro/edição |
| `screen-detalhe-agendamento` | Detalhe Agendamento | agenda | ver, editar, cancelar (com confirmação) |
| `screen-notificacoes` | Notificações | sino no header | — |
| `screen-perfil-eletricista` | Meu Perfil | título header | dados + toggles de config |
| `screen-relatorio` | Relatório Financeiro | "VER TODOS" | faturado/aberto, contagens, gráfico |

Layout de cada tela: **Topbar fixa** (título + navegação) · **Scroll-body** (conteúdo) ·
**Bottom-bar fixa** (FAB `+` ou botões duais).

---

## 6. Funcionalidades por área

- **Orçamento:** selecionar materiais cadastrados (com quantidade), adicionar itens de mão de
  obra avulsos, cálculo automático de subtotais e total geral, remover item com confirmação,
  salvar como PDF, salvar rascunho.
- **Materiais:** CRUD, busca por nome, filtro por categoria (chips), edição in-place.
- **Pagamentos:** registrar com validação (cliente, serviço, valor > 0, data), filtro por
  status e "este mês", ação contextual por status (`COBRAR AGORA`/`ENVIAR AVISO`/`VER RECIBO`).
- **Agenda:** calendário mensal navegável (mês anterior/próximo), dia atual destacado, dots em
  dias com evento; lista agrupada por dia com labels "HOJE"/"AMANHÃ"; detalhe com editar/cancelar.
- **Home:** agenda de hoje + esta semana, pagamentos a receber (total + top 2), busca global
  (materiais + agendamentos + pagamentos agrupados).
- **Relatório:** total faturado (status pago), total em aberto (pendente+atrasado), contagem
  de orçamentos, gráfico de barras.
- **Feedback:** toast não-intrusivo (2,5s) para sucesso; modal de confirmação para ações
  destrutivas (cancelar agendamento, remover item).

---

## 7. Gaps a resolver (prioridade)

Estes são os pontos onde o protótipo é maquete e precisa virar produto:

1. **Persistência real (CRÍTICO).** Hoje tudo vive em arrays em memória — recarregou, perdeu.
   Migrar para IndexedDB. Toda mutação (`salvar*`, `remover*`, `editar*`, `push`/`splice`/`unshift`)
   deve gravar no banco e re-hidratar na abertura.
   **Tratamento de falha:** toda gravação em `try/catch` (ou `.catch`); se falhar — quota cheia,
   ou aba anônima onde o IndexedDB é bloqueado — **nunca** dar como salvo. Mostrar toast de erro
   ("Não foi possível salvar. Verifique o espaço do aparelho.") e manter o dado em tela pra retry.
   Detectar IDB indisponível na abertura e avisar (app degrada, não finge persistir).
2. **PDF real.** `salvarOrcamentoPDF()` (script.js:450) hoje só faz `goTo('screen-home')`. Gerar
   PDF de verdade do orçamento (jsPDF na Fase A; plugin nativo no Capacitor). Layout: cabeçalho
   com dados do eletricista, cliente, tabela de materiais, mão de obra, total, data.
   **Offline:** jsPDF é dependência externa — o service worker (§10 F4) **deve cachear** o script
   do jsPDF junto com os assets, senão a geração de PDF quebra em campo sem internet. Preferir
   versão local (bundle/`vendor/`) em vez de CDN.
3. **Cliente CRUD incompleto.** `salvarCliente()` (script.js:468) só mostra toast — não grava.
   Implementar cadastro real e ligar orçamentos/pagamentos a `clienteId`.
4. **Offline / instalável.** Adicionar manifest + service worker (Fase A).
5. **Notificações.** Tela existe mas sem lógica; lembrete de agendamento e cobrança (Fase B).
6. **IDs estáveis.** Hoje entidades se referenciam por índice de array (frágil): `agendamentos.splice(_agendamentoIdx,1)` (script.js:270,284), `editarMaterial(idx)` (:382), e o picker deduplica material por **nome** (`x.nome === m.nome`, :630) em vez de id. Adotar `id` único (§4.1); deletar/editar/referenciar sempre por `id`, e o item de orçamento guardar `materialId`.

---

## 8. Regras de negócio

- `Orcamento.total` = soma dos itens, sempre revalidado (ver §4).
- Valores monetários: 2 casas decimais, exibição `R$ X.XXX,XX` (pt-BR).
- Preço de material e valor de mão de obra: **> 0** (validar).
- Cancelar agendamento e remover item de orçamento: **exigem confirmação**.
- Status governa a ação primária exibida (não duplicar lógica — mapear via tabela como no protótipo).

### 8.1 Máquina de status e relação Orçamento → Pagamento

**São dois vocabulários distintos.** Orçamento rastreia a *venda*; Pagamento rastreia o
*dinheiro*. `aprovado` só existe em Orçamento; `pago`/`atrasado` só em Pagamento.

**Ciclo do Orçamento** (transições manuais, por botão):
```
rascunho ──[enviar]──▶ enviado ──[APROVAR]──▶ aprovado ──(gera)──▶ Pagamento(pendente)
                          │
                          └──[RECUSAR]──▶ recusado   (fim, sem pagamento)
```
- `rascunho`: salvo local (`salvarRascunho`), ainda não mandado.
- `enviado`: mandado ao cliente. **Enviar ≠ aceito** — fica aqui até o cliente responder.
- `aprovado`: cliente aceitou. Botão **APROVAR** (manual) faz a transição **e gera um Pagamento**
  (ver abaixo). Orçamento aprovado vira read-only (não editar itens — quebraria o total já cobrado).
- `recusado`: cliente não quis. Estado final, nenhum pagamento. Serve pra métrica "serviços perdidos".

**Geração do Pagamento** (ao aprovar orçamento):
```
Pagamento = {
  id: crypto.randomUUID(),
  clienteId:   orcamento.clienteId,
  orcamentoId: orcamento.id,
  servico:     <resumo do orçamento>,
  valor:       orcamento.total,       // revalidado dos itens (§8)
  status:      'pendente',
  forma:       null,                  // definida ao registrar/cobrar
  dataVencimento: <informada manualmente no fluxo APROVAR>,
}
```
O botão **APROVAR** abre um passo pedindo a **data de vencimento** (obrigatória, escolhida pelo
eletricista — sem prazo fixo) antes de gravar o Pagamento. `atrasado` deriva dessa data (§8.1).
Pagamento avulso (sem orçamento) continua possível via tela Pagamentos — `orcamentoId` fica ausente.

**Ciclo do Pagamento** (transição manual):
```
pendente ──[MARCAR PAGO]──▶ pago     (confirma; grava dataPagamento e forma)
```
- `atrasado` **não é estado salvo** — é derivado no render: `pendente && dataVencimento < hoje`.
  Recalcula a cada abertura; nada a persistir, nunca desatualiza.
- Botões de ação por status (mapa como no protótipo): `pendente/atrasado` → **COBRAR AGORA** /
  **ENVIAR AVISO** (abrem WhatsApp/PIX — stub na F2, real na F4/B) **+ MARCAR PAGO** (a baixa real);
  `pago` → **VER RECIBO**. COBRAR **não** muda status — só avisa o cliente; a baixa é sempre MARCAR PAGO.

**Relatório (§6) usando o novo modelo:** faturado = Σ pagamentos `pago`; em aberto = Σ pagamentos
`pendente` (inclui os derivados-`atrasado`); "serviços perdidos" = contagem de orçamentos `recusado`.

### 8.2 Datas e relógio do aparelho

Como `atrasado`, vencimento, "hoje/amanhã" e o calendário dependem todos da data, o tratamento
de tempo é regra de negócio, não detalhe.

**Regra 1 — data sempre no fuso do aparelho.** Toda data (`YYYY-MM-DD`) é montada com os métodos
**locais** do dispositivo, nunca com `toISOString()` (que converte para UTC e, após ~21h no Brasil
UTC-3, grava o dia seguinte — corrompe filtro "hoje", vencimento e cálculo de `atrasado`).
```js
function hojeLocal() {                    // substitui new Date().toISOString().split('T')[0]
  const d = new Date();                   // lê o relógio do próprio aparelho
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
```
Aplicar em: criação de pagamento/agendamento/orçamento, comparação de vencimento (`atrasado`),
labels "HOJE"/"AMANHÃ", destaque do dia atual no calendário. Corrigir também o `script.js:459`.

**Regra 2 — verificação de relógio sincronizado.** Como todas as datas saem do relógio do
aparelho, um relógio errado (usuário mexeu na hora, bateria/RTC dessincronizado) contamina
vencimentos e `atrasado` sem o usuário perceber. Duas checagens na abertura do app:

1. **Online:** comparar o relógio do aparelho com uma fonte confiável — o header HTTP `Date` de
   uma resposta do próprio servidor/service worker (ou uma API de tempo). Deriva **> 5 min** →
   exibir **caixa de aviso** (banner dispensável, não-bloqueante):
   > ⚠️ *O relógio do seu aparelho parece fora de hora. Vencimentos e alertas podem sair errados.
   > Ative "data e hora automática" nas configurações do celular.*
2. **Offline (sem fonte confiável):** guardar em `preferencias` o **maior timestamp já visto**
   (`ultimoTimestampVisto`). Se numa abertura o relógio atual for **menor** que esse valor, o
   relógio andou pra trás → exibir a mesma caixa de aviso. Atualizar `ultimoTimestampVisto` a
   cada sessão.

O aviso é informativo (não impede uso) e some ao dispensar ou quando o relógio voltar ao normal.

---

## 9. Design system (extrair de `style.css`)

**Cores de status (semânticas, consistentes em todo o app):**
- Pagamento: 🟡 Pendente `#f59e0b` · 🔴 Atrasado `#ef4444` (derivado) · 🟢 Pago `#22c55e`
- Orçamento: ⚪ Rascunho `#9ca3af` · 🟡 Enviado `#f59e0b` · 🔵 Aprovado `#3b82f6` · 🔴 Recusado `#ef4444`
- Azul-marinho primário: `#1e3a5f` (botões de ação, topbar).

**Layout:** largura de referência 375px, proporção ~9:19,5 (iPhone 14/15). Topbar + scroll-body
+ bottom-bar. FAB `+` sempre visível nas listagens.

**Convenções CSS:** kebab-case com prefixo por contexto — `pay-`, `orc-`, `cal-`, `notif-`,
`rel-`, `mat-`, `ag-`. Manter ao estender.

**Princípios IHC aplicados** (preservar): visibilidade de estado (cores + toast), controle e
liberdade (voltar em toda tela secundária, confirmação antes de destruir), consistência
(tipografia/espaçamento/componentes únicos), reconhecimento vs. recordação (FAB, chips de
filtro visíveis, dots no calendário), design para erro (validação inline com mensagem abaixo
do campo, placeholders descritivos, `type="number"` com `min`).

**Acessibilidade:** `aria-label` em botões de ação, `role="button"` em interativos não-nativos,
`aria-live="polite"` na busca, contraste mínimo 4,5:1.

---

## 10. Roadmap sugerido de construção

- [ ] **F0 — Setup:** estrutura do projeto (PWA), copiar HTML/CSS/JS do protótipo, servir localmente.
- [ ] **F1 — Persistência:** camada IndexedDB, migrar todas as entidades, seed com dados-exemplo.
- [ ] **F2 — Cliente CRUD real:** cadastro/edição/exclusão, ligar por `clienteId`.
- [ ] **F3 — PDF real:** geração do orçamento em PDF.
- [ ] **F4 — Offline:** manifest + service worker + ícones. Instalável.
- [ ] **F5 — Relatório completo:** gráfico real, ranking de clientes.
- [ ] **F6 — Notificações:** lembretes de agenda e cobrança.
- [ ] **F7 — Capacitor:** empacotar, testar em Android, publicar.

---

## 11. Instruções ao modelo construtor

1. **Leia `prototipo-referencia/` inteiro antes de codar.** `index.html` (telas), `style.css`
   (design), `script.js` (lógica e dados), `README.md` (IHC), `screenshots/` (visual esperado).
2. Não invente UI nova — replique o protótipo. Divergência só onde §7 pede.
3. Preserve as cores de status, prefixos CSS e princípios IHC listados.
4. Toda mutação de dado deve persistir. Nada pode se perder ao recarregar.
5. Formate dinheiro em pt-BR. Valide entradas como o protótipo já faz.
6. Comece pela Fase A (PWA). Entregue algo rodando e persistente antes de partir para nativo.
7. Ao terminar cada fase do §10, teste o fluxo completo (criar → listar → editar → excluir).

---

*Protótipo online de referência: https://erik-gastao.github.io/electricbudget/*
