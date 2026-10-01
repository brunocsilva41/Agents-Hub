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
| Verificar um envelope com uma chave pública | `ahsign verify --public-key <64 hex> --in <envelope>` |

- A senha é lida do terminal, sem eco (`generate` pede duas vezes). Com `--password-stdin`, vem da
  primeira linha de stdin (uso em teste). Não há opção de senha por argumento nem por variável de
  ambiente.
- `generate` e `sign` nunca sobrescrevem: se o arquivo de saída existe, recusam antes de pedir a
  senha.
- Saída: 0 sucesso, 1 falha da operação (senha errada, assinatura inválida, arquivo existente), 2 uso
  incorreto.
- Nada secreto é impresso: só o `key_id` e a chave pública.

## Arquivo de chave

153 bytes, layout em `ahsign_key.h`: cabeçalho fixo de 24 bytes (a constante `ahsign_key_file_magic`,
definida só em `ahsign_key.c`), custo do Argon2id, sal (16 bytes) e nonce (24 bytes) do gerador do
SO, chave pública em claro, MAC e a semente Ed25519 cifrada com `crypto_aead_lock`. A chave da cifra
vem de `crypto_argon2` (Argon2id, 256 MiB, 3 passadas). Os dados associados cobrem cabeçalho, custo,
sal, nonce e chave pública. Senha errada e arquivo adulterado dão o mesmo erro.

O cabeçalho fixo existe para o teste `unit.ahsign.secret_scan` (T14, SEC-R22) detectar um arquivo de
chave que vaze para o repositório, para um workflow ou para o executável `hub`.

## Testes

`ctest --preset <preset>` roda, entre outros:

| Teste | O que prova |
|---|---|
| `unit.updater.verify` | T1 (vetores do RFC 8032 §7.1 em `crypto_ed25519_check`, recusados por `crypto_eddsa_check`), T2 (bit invertido em qualquer byte, chave desconhecida), T3 (sem o prefixo de domínio), T4 (> 64 KiB recusado antes de verificar) |
| `unit.ahsign.key` | arquivo de chave sem a semente em claro, senha errada, byte adulterado, faixa do Argon2, assinatura e exportação |
| `unit.ahsign.roundtrip` | gerar → exportar → assinar → verificar pela linha de comando, com chave e senha de teste num diretório do build |
| `unit.ahsign.secret_scan` | T14: o cabeçalho do arquivo de chave não aparece em nenhum arquivo do repositório (rastreado ou novo não ignorado), nos workflows nem no `hub` |

Todas as chaves dos testes são efêmeras ou vetores públicos. O Argon2id de 256 MiB deixa o
`unit.ahsign.roundtrip` lento fora do Release (cerca de 55 s em Debug no MSVC, 45 s com ASan e 11 s
em Release, medidos em 2026-09-30).

## Pendências fora desta ferramenta

- A chave real não foi gerada: só o dono a gera, numa máquina dele, fora do repositório. As duas chaves
  públicas (atual e de recuperação) entram depois em `native/src/updater/` com a saída de
  `ahsign public`.
- `ahsign_os.c` chama o SO fora de `native/src/platform/`: exceção temporária até a F0-06.
