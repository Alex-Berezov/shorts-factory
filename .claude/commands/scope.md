---
description: Рамки правок текущей задачи - режим strict/soft/off, явная зона (шаблоны путей), просмотр накопленных выходов за зону.
argument-hint: strict | soft | off | show | zone <шаблон...> | zone clear
model: sonnet
allowed-tools: Bash, Read
---

# /scope - границы задачи

Аргумент: `$ARGUMENTS`

Файл `.claude/scope.txt` держит режим и зону; читает его хук `scope.js` на каждой записи файла.

```
# зафиксировано 2026-09-05, E0-04
mode: soft
sf/packages/db/**
```

- `mode: strict|soft|off` - режим. `soft` (и файла нет) - выходы за зону копятся в `.qa-state`
  (`strayFiles`), запрет включается после `scope.softLimit` (12) файлов; `strict` - любой выход
  запрещён сразу; `off` - хук молчит.
- Остальные строки - зона, каждая с префиксом `sf/`. Строк нет - зона считается из диффа:
  файлы диффа плюс их папки. Зона нужна ровно для **первого файла в новой папке**: папки нет
  в диффе, пока в ней нет файлов - назови её заранее, а не снимай рамки.
- Всегда разрешено (`scope.alwaysAllowed` в `rules.common.json`): тесты, `docs/**`, `tasks/**`,
  миграции, `*.md`.

## Команды

`strict` / `soft` / `off` - заменить строку режима, зону сохранить:

```
node -e "const fs=require('fs'),p='.claude/scope.txt';const m=process.argv[1];let ls=[];try{ls=fs.readFileSync(p,'utf8').split(/\r?\n/)}catch(e){}ls=ls.filter(l=>l.trim()&&!/^#?\s*mode\s*:/i.test(l));let i=0;while(i<ls.length&&ls[i].startsWith('#'))i++;ls.splice(i,0,'mode: '+m);fs.writeFileSync(p,ls.join('\n')+'\n');process.stdout.write(fs.readFileSync(p,'utf8'))" strict
```

`zone <шаблон> [...]` - записать зону (каждый шаблон с префиксом `sf/`; без него - не записывать
и сказать об этом), режим не трогать:

```
node -e "const fs=require('fs'),p='.claude/scope.txt';const add=process.argv.slice(1);let ls=[];try{ls=fs.readFileSync(p,'utf8').split(/\r?\n/)}catch(e){}const mode=(ls.find(l=>/^#?\s*mode\s*:/i.test(l))||'mode: soft').replace(/^#\s*/,'');fs.writeFileSync(p,['# зафиксировано '+new Date().toISOString().slice(0,10),mode].concat(add).join('\n')+'\n');process.stdout.write(fs.readFileSync(p,'utf8'))" sf/packages/db/**
```

`zone clear` - убрать строки зоны, вернуться к зоне из диффа.

`show` (и пустой аргумент) - показать файл, дифф против `main` и накопленные `strayFiles`
из `.claude/.qa-state`; ничего не менять.

После записи покажи файл целиком - три-четыре строки. Ответ в чат - до четырёх строк.
