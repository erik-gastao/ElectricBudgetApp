# Electric Budget

## README sempre em dia

Antes de cada commit que mude comportamento do app, instalação, atualizações,
release/CI, arquitetura, dados ou comandos de desenvolvimento, chame o agente
`readme-updater` e inclua no mesmo commit o que ele alterar no `README.md`.
Pule só em mudanças que não afetam nada descrito no README (refatoração
interna, estilo, correção sem mudança visível).

## Releases

- Toda release atualiza `app/versao.json` (`ultima`, `notas`, `apk`) no mesmo
  commit da tag `vX.Y.Z`; o CI falha se não bater.
- O CI cria a branch `release/vX.Y.Z` depois de publicar o APK. Não crie nem
  apague essas branches à mão sem pedido.
