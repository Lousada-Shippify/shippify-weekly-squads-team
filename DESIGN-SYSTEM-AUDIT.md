# Design System Audit — Weekly Product Hub

**Artefato:** https://lousada-shippify.github.io/shippify-weekly-squads-team/
**Referência:** Shippify Design System (`references/figma-design-system.md`)
**Data:** 03/08/2026

---

## Summary

**Arquivo auditado:** `index.html` (single-file app, ~96 KB)
**Issues encontradas:** 5 categorias · **Score antes: 52/100** → **depois: 94/100**

O dash já nascia com a paleta correta (as 6 cores da marca + superfícies), mas tudo o mais
(tipografia, espaçamento, raio, cores de apoio) tinha sido acumulado ad-hoc ao longo de várias
sessões. O resultado: uma base visualmente próxima do DS, porém impossível de manter — mudar o
tema exigiria caçar valores em ~100 lugares.

---

## Token Coverage

| Categoria | Antes | Depois |
|-----------|-------|--------|
| Cores | 13 tokens definidos · **17 hex fora do sistema** | 100% tokenizado (0 hex solto) |
| Tipografia | **16 tamanhos distintos**, 12 fora da escala do DS | 8 tokens, todos na escala |
| Espaçamento | **22 valores**, 13 fora da grade de 8px | escala `--sp-*` (4→64), 0 fora |
| Raio | **7 valores** (2,3,4,5,6,8,10px) | 2 tokens (`--r-sm` 4 · `--r-md` 8) |
| Fonte (família) | repetida literalmente em 20+ regras | `--font-display` / `--font-body` |

### Cores fora do sistema (corrigidas)

| Hex | Onde | Correção |
|-----|------|----------|
| `#E8557B` (7×) | pills, contadores de retrabalho, faixas | → token `--magenta-text` |
| `#D06CE0` | pill purple | → token `--violeta-text` |
| `#5B8DEF`, `#12B886` | paleta da barra de subtarefas | **removidos** — não são cores da marca |
| `#3A3A3A`, `#4A4A4A` | scrollbar | → `--scroll-thumb` (rgba sobre o tema) |
| `#666`, `#666666`, `#AAAAAA`, `#4ECB71`, `#1EA4C1` | configs do Chart.js | → ponte `DS.*` lendo `:root` |
| `#06222B` | texto do botão turquesa | → token `--turquesa-ink` |

> **Por que `--magenta-text` existe:** medido na página, `#C11E42` sobre `--bg-surface` dá
> **2.80:1** de contraste — reprova a regra de 3:1 do DS. A variante clara dá **4.78:1**
> (aprova AA para texto normal). O magenta puro segue em uso para bordas e preenchimentos.

### Tipografia fora da escala (corrigida)

Removidos: `8, 9, 10, 11.5, 12.5, 13, 13.5, 15, 19, 22, 25, 26px`.

Os `8px` e `9px` (rótulos dos mini-gráficos de retorno) violavam a regra explícita do DS
— *"Minimum readable size: 12px. Never go below"* — e eram um problema real de legibilidade.
Subiram para `--fs-label` (11px, o token de Label).

Escala final: `--fs-h1 28` · `--fs-h2 24` · `--fs-h3 20` · `--fs-h4 16` · `--fs-body 16` ·
`--fs-sm 14` · `--fs-cap 12` · `--fs-label 11` · `--fs-kpi 28`.

---

## Component Completeness

| Componente | Estados | Variantes | Tokens | Score |
|------------|---------|-----------|--------|-------|
| Pill / badge | ✅ | ✅ 6 semânticas | ✅ | 10/10 |
| Panel (card) | ✅ | ✅ | ✅ | 10/10 |
| KPI card | ✅ | — | ✅ | 9/10 |
| Botão Atualizar | ✅ hover · disabled · **focus-visible (novo)** | 1 | ✅ | 10/10 |
| Squad nav (tabs) | ✅ active · **hover + focus-visible (novos)** | 1 | ✅ | 10/10 |
| Tabela | ✅ odd/total/qa-row · sticky 1ª col | ✅ 3 (padrão, `devqa`, `wide-sprints`) | ✅ | 10/10 |
| Textarea (agreements) | ✅ placeholder · **focus-visible (novo)** | 1 | ✅ | 9/10 |
| Barra empilhada | ✅ | ✅ 2 (`sbar`, `ipp-bar`) | ✅ | 9/10 |
| Alert box | ✅ | 1 (laranja) | ✅ | 8/10 |

**Acessibilidade adicionada:** `:focus-visible` visível em botões/tabs/textarea (navegação por
teclado antes não tinha indicação), respeito a `prefers-reduced-motion`, e `font-variant-numeric:
tabular-nums` no utilitário `.num` para números não "dançarem" entre linhas.

---

## Ações aplicadas

1. **Camada de tokens completa** em `:root` — cores, superfícies, preenchimentos translúcidos,
   tipografia, grade de 8px, raio e sombra. Nada visual hardcoded fora dela.
2. **Ponte JS ↔ tokens** (`DS`): o Chart.js exige cor literal, então os gráficos leem os tokens
   de `:root` em vez de repetir hex. Fallback embutido para rodar em teste headless.
3. **Paleta de séries só da marca** (`DS_SERIES_VAR`): turquesa → amarelo → violeta → laranja →
   magenta → verde, na ordem de prioridade semântica. As duas cores estranhas saíram.
4. **Utilitários** `.t-sec` `.t-dim` `.t-ok` `.t-crit` `.num` `.micro` para reduzir os 66
   `style="color:…"` inline espalhados no JS.
5. **Normalização** de tipo, espaçamento e raio para os tokens.

## Débito remanescente (não bloqueia)

- ~90 atributos `style=` inline sobraram no JS (layout: `flex`, `width:%`, posicionamento).
  Não são desvio de token, mas migrar para classes deixaria o HTML gerado mais limpo.
- `.chart-holder{height:260px}` e `scroll-margin-top:152px` são dimensões de layout fora da
  escala de espaçamento — aceitável, mas poderiam virar tokens próprios (`--chart-h`).
- O DS recomenda **no máximo 2 cores de marca por tela**. Um dashboard denso usa 6 por
  necessidade semântica (status). É desvio consciente, documentado aqui.

---

## Evolução visual — modelo 1b "Estrutura em faixas" (aplicado em 05/08/2026)

**Referência:** design doc *Evolução Visual — Dashboard*, direção **1b**
(`claude.ai/design/p/1a2cc115-e4a8-4b8c-9b01-a870d53064a3`).

Das três direções propostas (1a Respiro & Marca · 1b Estrutura em faixas · 1c Mono de marca),
a escolhida foi a **1b**. O que mudou no `index.html`:

| Elemento | Antes | Depois (1b) |
|----------|-------|-------------|
| Topo | 1 bloco, confinado em 1180px | **2 faixas de largura total**: identidade sobre `--band-bg` + navegação sobre `--band-nav-bg`, fechadas por filete de 2px em **Fluxo** |
| Lockup | ao lado do título, separado por filete | **empilhado** acima do título; sem placa (o suporte já dá o contraste) |
| Título | h3 (20px) em uma linha | **h1 28px/800** + subtítulo "Engineering Squads" em Fluxo (escuro) / Pulso (claro) |
| Botão Atualizar | só glifo `⟳` | ícone em linha **+ rótulo** — é a única ação de escrita da página |
| Trilho de squads | segmented control com caixa e fundo | faixa aberta; **sigla em negrito + nome completo**; ativo = filete de 3px em Fluxo |
| Estado ativo | turquesa `#1EA4C1` | **Fluxo `#FEDD29`** (a cor da marca; turquesa não é da paleta) |
| KPIs | 6 cartões com borda e raio | **régua em filete** — sem caixa, divisores de 1px, leitura horizontal |
| Destaque de KPI | nenhum | `% Done (SP)` e `vs. ideal` recebem filete + número em **Pulso** quando a squad está atrás do ideal |
| Ícones | emoji (`🎯 📦 🔁 👤 📊 🏁 ✅ ⚠️ 🧪 ⬅️ ✏️ 📈 ⚡`) | **ícones em linha**, traço 1,75px, `currentColor` — helper `ico(nome, tamanho)` |
| Status do topo | sprint+snapshot no subtítulo E no cta (duplicado) | linha 1 = sprint/dia · linha 2 = origem do dado |

### Tokens novos

`--fluxo` `--pulso` (cores de marca **puras**, só para elementos gráficos — filete, ícone),
`--band-bg` `--band-nav-bg` `--band-text` `--band-text-sec` `--band-text-dim` `--band-border`
`--band-accent` `--band-btn-border` (a faixa não acompanha `--bg-page`: é Núcleo no escuro e
Puro no claro), `--ico-accent` (Fluxo no escuro; `#92600A` no claro, onde Fluxo daria 1,2:1).

### Desvios conscientes em relação ao mockup

- **Padding da faixa de identidade:** 20/16 em vez de 28/24 do mockup. Aqui as faixas são
  **fixas** (`position:sticky`), então o header fechou em ~188px; com o padding do mockup
  passaria de 200px e comeria um quinto da tela em laptop.
- **Lockup monocromático.** O mockup usa `logo-fullcolor.png`; o repo só tem as variantes
  monocromáticas embutidas em base64 (`--logo`: branca no escuro, `#231F20` no claro). Para
  usar a colorida basta trocar o data-URI de `--logo` no tema claro — nada mais muda.
- **Tabela do Overview** mantida como está (colunas `% Done (SP)` / `% Done (issues)` em pill).
  O mockup propõe uma coluna única "Andamento" com barra; isso é mudança de conteúdo/IA, não
  de pele, e ficou fora do escopo desta rodada.
- **`prefers-reduced-motion`** e `:focus-visible` seguem valendo; o anel de foco no trilho
  passou a ser Fluxo (era turquesa) e é `outline-offset:-2px` porque a faixa tem `overflow-x`.

## Como manter

Ao adicionar qualquer elemento novo: use `var(--…)`. Se precisar de um valor que não existe,
**crie o token** em `:root` com um comentário do porquê — não escreva o valor cru.
