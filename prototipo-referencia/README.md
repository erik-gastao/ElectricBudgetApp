# Electric Budget

Protótipo mobile de aplicativo para eletricistas autônomos — orçamentos, agenda, clientes e pagamentos.

## Acesso

**Link:** https://erik-gastao.github.io/electricbudget/

**QR Code:** https://erik-gastao.github.io/electricbudget/qrcode.html

## Telas

| Tela | Descrição |
|------|-----------|
| Home | Dashboard com agenda do dia, orçamentos e pagamentos |
| Clientes | Lista, perfil e cadastro de clientes |
| Materiais | Lista com busca/filtro e cadastro de novos materiais |
| Orçamento | Criação com picker de materiais e mão de obra, totais automáticos |
| Agenda | Calendário mensal, lista de compromissos e detalhes |
| Pagamentos | Lista filtrável e registro de pagamentos |
| Relatório | Gráfico de receita mensal e ranking de clientes |
| Perfil | Dados do eletricista e configurações |

## Funcionalidades

- Cadastro de materiais com categoria, unidade e preço
- Orçamento com seleção de materiais cadastrados e cálculo automático de totais
- Agendamento com visualização por dia/semana e tela de detalhes
- Registro de pagamentos com status (pago, pendente, atrasado)
- Calendário interativo com marcação de dias com evento
- Filtros por categoria e status em todas as listas

## Design de Interface e IHC

### Princípios aplicados

O protótipo foi desenvolvido com base nos princípios de **Interação Humano-Computador (IHC)** voltados para uso mobile em contexto de trabalho de campo.

#### Visibilidade do estado do sistema
Cada elemento com status (pagamentos, orçamentos) exibe cores semânticas consistentes:
- 🟡 Pendente `#f59e0b` — aguarda ação
- 🔴 Atrasado `#ef4444` — atenção requerida
- 🟢 Pago `#22c55e` — concluído
- 🔵 Aprovado `#3b82f6` — confirmado pelo cliente

Feedback imediato via **toast** não-intrusivo e **modal de confirmação** para ações destrutivas.

#### Controle e liberdade do usuário
- Botão de voltar (`←`) em todas as telas secundárias
- Confirmação antes de cancelar agendamentos
- Ações contextuais no detalhe do orçamento mudam conforme status (`COBRAR AGORA` → `VER RECIBO`)

#### Consistência e padrões
- Tipografia, espaçamentos e componentes (cards, chips, formulários) seguem padrão único em todas as telas
- Nomenclatura de ações em caixa alta no estilo de app nativo (botões, labels)
- Prefixos CSS por contexto (`pay-`, `orc-`, `cal-`, `notif-`, `rel-`) para coerência visual e manutenibilidade

#### Reconhecimento em vez de recordação
- FAB (`+`) sempre visível nas telas de listagem — usuário não precisa navegar para achar a ação principal
- Chips de filtro exibem todas as categorias disponíveis sem digitação
- Calendário com dots em dias com evento — contexto visual sem abrir detalhe

#### Design para erros
- Validação inline nos formulários com mensagem abaixo do campo
- Campos com placeholders descritivos (`Ex: Instalação de quadro elétrico`)
- Campos numéricos com `type="number"` e `min` para evitar entrada inválida

### Layout e proporção

Proporção **9:19,5** (equivalente ao iPhone 14/15) simulada em desktop via `aspect-ratio` + `dvh`. Tela de 375px de largura — resolução de referência para design mobile.

Hierarquia visual:
1. **Topbar** fixa com título e navegação
2. **Scroll-body** com conteúdo principal rolável
3. **Bottom-bar** fixa com ação primária (FAB ou botões duais)

### Acessibilidade

- `aria-label` em botões de ação (voltar, sinos, FAB)
- `role="button"` em elementos interativos não-nativos
- `aria-live="polite"` na área de resultados de busca global
- Contraste mínimo 4,5:1 nos textos principais sobre fundo branco

## Stack

- HTML + CSS + JS puro (sem framework, sem build)
- Single-page com múltiplas telas `.screen` dentro de `.phone`
- Proporção 9:16 responsiva via `aspect-ratio` + `dvh`
- Navegação via `goTo(id)` em `script.js`

## Equipe

- Erik Gastão
- Ana Luisa(https://github.com/cCarpa25)
