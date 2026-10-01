# ahsign — chave e assinatura do manifesto de atualização (F8-05)

Ferramenta do dono do projeto para a opção **O2** da
[proposta F8-04](../../../docs/propostas/F8-04-chave-e-manifesto-de-atualizacao.md), adotada no
[ADR 09 §9.7](../../../docs/decisoes/09-rodada-1-divergencias-e-decisoes.md): a chave diária fica
num arquivo cifrado com senha, e a de recuperação em outra mídia. Não entra no produto instalado.
A verificação que o atualizador usa é a mesma (`native/src/updater/ah_update_verify.h`).

## Comandos

Compilada com o resto de `native/` (alvo `ahsign`, em `build/<preset>/bin/`).

| Ação | Comando |
|---|---|
| Gerar um par de chaves | `ahsign generate --out <arquivo-da-chave>` |
| Exportar a chave pública como inicializador C de `ah_update_key` | `ahsign public --key <arquivo-da-chave> --name <nome>` |
| Assinar um corpo de manifesto e gerar o envelope | `ahsign sign --key <arquivo-da-chave> --body <corpo> --out <envelope>` |
| Verificar um envelope com uma chave pública | `ahsign verify --public-key <64 hex> --in <envelope>` (recusa chave de ordem pequena; `public` também) |

- A senha é lida do terminal, sem eco (`generate` pede duas vezes); Ctrl+C durante a leitura devolve
  o eco ao terminal. Com `--password-stdin`, vem da primeira linha de stdin, lida byte a byte sem o
  buffer da CRT, e é recusada se stdin for o próprio terminal (a senha apareceria com eco). Não há
  opção de senha por argumento nem por variável de ambiente.
- `generate` e `sign` nunca sobrescrevem: se o arquivo de saída existe, recusam antes de pedir a
  senha.
- Saída: 0 sucesso, 1 falha da operação (senha errada, assinatura inválida, arquivo existente), 2 uso
  incorreto.
- Nada secreto é impresso: só o `key_id` e a chave pública.
- `public` e `sign` avisam quando o custo do Argon2id gravado no arquivo está abaixo do padrão. Não há
  opção de custo na linha de comando: toda chave de `generate` sai com o custo padrão.

## Arquivo de chave

153 bytes, layout em `ahsign_key.h`: cabeçalho fixo de 24 bytes (a constante `ahsign_key_file_magic`,
definida só em `ahsign_key.c`), custo do Argon2id, sal (16 bytes) e nonce (24 bytes) do gerador do
SO, chave pública em claro, MAC e a semente Ed25519 cifrada com `crypto_aead_lock`. A chave da cifra
vem de `crypto_argon2` (Argon2id, 256 MiB, 3 passadas). Os dados associados cobrem cabeçalho, custo,
sal, nonce e chave pública. Senha errada e arquivo adulterado dão o mesmo erro.

**Permissão do arquivo.** No Windows o arquivo nasce com DACL protegida (sem herdar da pasta) e uma
única entrada, acesso total para o SID do usuário que roda o `ahsign`. No POSIX nasce com modo 0600,
e `generate` avisa se a pasta aceita escrita de grupo ou de outros usuários (quem escreve na pasta
pode trocar o arquivo). **Em mídia FAT/exFAT (pendrive, cartão) não há ACL nem modo: só a senha
protege a chave.** Use uma senha longa, e guarde a chave de recuperação em outra mídia.

O cabeçalho fixo existe para o teste `unit.ahsign.secret_scan` (T14, SEC-R22) detectar um arquivo de
chave que vaze para o repositório, para um workflow ou para o executável `hub`.

## Testes

`ctest --preset <preset>` roda, entre outros:

| Teste | O que prova |
|---|---|
| `unit.updater.verify` | T1 (vetores do RFC 8032 §7.1 em `crypto_ed25519_check`, recusados por `crypto_eddsa_check`), T2 (bit invertido em qualquer byte, chave desconhecida), T3 (sem o prefixo de domínio), T4 (> 64 KiB recusado antes de verificar); S ≥ L, hex maiúsculo, CRLF, BOM, NUL e `key:` repetido recusados; `sig:` antes de `key:` recusado; A e R não canônicos aceitos pelo Monocypher (fixado), e chave pública de ordem pequena (as 14 codificações dos 8 pontos de torção) recusada como tabela embutida inválida (SEC-R17) |
| `unit.ahsign.key` | arquivo de chave sem a semente em claro, senha errada, byte adulterado, faixa do Argon2, assinatura, exportação e arquivo criado privado (DACL só do usuário / 0600) |
| `unit.ahsign.roundtrip` | gerar → exportar → assinar → verificar pela linha de comando, com chave e senha de teste num diretório do build |
| `unit.ahsign.secret_scan` | T14: o cabeçalho do arquivo de chave não aparece em nenhum arquivo do repositório (rastreado ou novo não ignorado), nos workflows nem no `hub`; cada arquivo permitido tem exatamente uma ocorrência, e em `ahsign_key.c` só na linha da definição |

Todas as chaves dos testes são efêmeras ou vetores públicos. O `unit.ahsign.roundtrip` faz um único
`generate` com o custo cheio (256 MiB); `public` e `sign` usam um arquivo de custo baixo selado pelo
núcleo por um auxiliar só de teste (`ahsign_test_fixture`), e a "outra chave" é a chave pública do
TEST 1 do RFC 8032.

## Pendências fora desta ferramenta

- A chave real não foi gerada: só o dono a gera, numa máquina dele, fora do repositório. As duas chaves
  públicas (atual e de recuperação) entram depois em `native/src/updater/` com a saída de
  `ahsign public`.
- A aleatoriedade vem de `ah_platform_random_bytes` (F0-06). `ahsign_os.c` ainda chama o SO fora de
  `native/src/platform/` para arquivos e argumentos (migram para a API de arquivos da F0-05) e para o
  terminal sem eco (sem área em `platform/` no plano).
