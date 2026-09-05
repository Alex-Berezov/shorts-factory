---
description: Где мы сейчас - текущая задача, следующие по трекеру, открытые стоп-условия, состояние обвязки. Ничего не меняет.
model: sonnet
allowed-tools: Bash, Read
---

# /status - где мы

```
node scripts/tasks.mjs next 3
node -e "const s=require('fs').readFileSync('docs/00_STATUS.md','utf8').split('\n');console.log(s.slice(4,12).join('\n'))"
node -e "let s={};try{s=JSON.parse(require('fs').readFileSync('.claude/.qa-state','utf8'))}catch(e){}console.log('edits:',s.edits||0,'| lastQa:',s.lastQa||'-','| lastGates:',s.lastGates?s.lastGates.code+' @ '+s.lastGates.at:'-')"
git status --porcelain | wc -l
```

Ответ - до восьми строк: текущий эпик; задача в работе (или «нет»); следующие две с оценкой;
заблокированные с причинами (из `docs/00_STATUS.md`, раздел «Заблокировано»); состояние
`.qa-state` одной строкой; число незакоммиченных файлов; последняя строка - что набрать дальше
(`/auto`, `/fix …`, либо действие владельца по стоп-условию).
