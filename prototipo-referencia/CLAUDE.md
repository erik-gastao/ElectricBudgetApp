# Electric Budget

Protótipo mobile de app para eletricistas autônomos — orçamentos, agenda, clientes e pagamentos.

## Stack
- HTML + CSS + JS puro (sem framework, sem build)
- Single-page: múltiplas `.screen` dentro de `.phone` (375px)
- Navegação via `goTo(id)` em `script.js`

## Telas

| ID | Título | Acesso |
|----|--------|--------|
| `screen-home` | Dashboard | inicial |
| `screen-pagamentos` | Pagamentos | home |
| `screen-clientes` | Lista Clientes | home |
| `screen-materiais` | Lista Materiais | home |
| `screen-orcamento` | Novo Orçamento | home / FAB |
| `screen-orcamento-detalhe` | Detalhes do Orçamento | perfil cliente |
| `screen-agenda` | Agenda | home |
| `screen-novo-cliente` | Novo Cliente | clientes / orçamento |
| `screen-perfil-cliente` | Perfil do Cliente | lista clientes |
| `screen-notificacoes` | Notificações | sino no header |
| `screen-perfil-eletricista` | Meu Perfil | título "ELECTRIC BUDGET" |
| `screen-relatorio` | Relatório Financeiro | VER TODOS em orçamentos |

## Histórico de mudanças

### Alinhamento com Figma
- Pagamentos HOME → cards cinzas com scroll em vez de box bordada
- Agenda → calendário placeholder cinza neutro (sem emoji)
- Orçamento → scroll interno independente por seção (materiais / mão de obra)
- Perfil cliente → FINANCEIRO com título + divisória preta

### Features adicionadas
- Calendário interativo real (grid mensal, dia atual destacado, dots em dias com evento)
- Tela de detalhes do orçamento (a partir do perfil do cliente)
- Tela de notificações (sino no header da home)
- Perfil do eletricista com toggles de configuração
- Relatório financeiro com gráfico de barras CSS e ranking de clientes

## Convenções CSS
- Classes: kebab-case com prefixo por contexto (`pay-`, `orc-`, `cal-`, `notif-`, `rel-`)
- Status cores: pendente `#f59e0b` · atrasado `#ef4444` · pago `#22c55e` · aprovado `#3b82f6`
- Valores monetários: formato BR `R$ X.XXX,XX`
