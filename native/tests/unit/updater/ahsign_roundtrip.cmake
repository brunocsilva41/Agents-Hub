# Ida e volta da ferramenta ahsign (F8-05): gerar → exportar → assinar →
# verificar, com chaves e senha de teste num diretório do build.
# Uso (registrado no CTest):
#   cmake -DAHSIGN=<exe> -DFIXTURE=<exe> -DWORK_DIR=<dir> -P este-arquivo
#
# Custo: um só `generate` com o Argon2id cheio (256 MiB). `public` e `sign`
# usam um arquivo de chave de custo baixo selado pelo núcleo (FIXTURE), e a
# "outra chave" do teste de recusa é uma chave pública fixa (RFC 8032 §7.1,
# TEST 1). O cabeçalho do arquivo de chave é montado por partes (o teste T14
# recusa o texto literal fora de ahsign_key.c).
cmake_minimum_required(VERSION 3.22)

foreach(_v AHSIGN FIXTURE)
  if(NOT ${_v} OR NOT EXISTS "${${_v}}")
    message(FATAL_ERROR "${_v} ausente: '${${_v}}'")
  endif()
endforeach()
if(NOT WORK_DIR)
  message(FATAL_ERROR "WORK_DIR ausente")
endif()

set(_failures 0)
# `cond` é reavaliado como código (cmake_language EVAL) para aceitar
# expressões com vários termos; compara-se por NOME de variável, nunca pelo
# valor embutido (os valores podem ter aspas e quebras de linha).
macro(check cond msg)
  set(_ok 1)
  cmake_language(EVAL CODE "if(NOT (${cond}))
  set(_ok 0)
endif()")
  if(NOT _ok)
    message(SEND_ERROR "falhou: ${msg}")
    math(EXPR _failures "${_failures} + 1")
  endif()
endmacro()

file(REMOVE_RECURSE "${WORK_DIR}")
file(MAKE_DIRECTORY "${WORK_DIR}")

set(PASSWORD "senha-de-teste-efemera-roundtrip")
file(WRITE "${WORK_DIR}/pw.txt" "${PASSWORD}\n")
file(WRITE "${WORK_DIR}/wrong.txt" "senha-errada\n")
file(WRITE "${WORK_DIR}/empty.txt" "")
set(BODY "{\n  \"schema\": 1,\n  \"product\": \"agents-hub\",\n  \"version\": \"0.1.0\"\n}\n")
file(WRITE "${WORK_DIR}/body.json" "${BODY}")
# Chave pública do RFC 8032 §7.1, TEST 1: só serve de "outra chave".
set(RFC_TEST1_PK "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
string(CONCAT _magic "agents-hub-" "secret-" "key-v1")
string(HEX "${_magic}" _magic_hex)

# Executa um programa e junta stdout+stderr; a senha nunca pode aparecer na saída.
function(run_prog out_rc out_text input exe)
  if(input)
    execute_process(COMMAND "${exe}" ${ARGN}
      INPUT_FILE "${input}"
      RESULT_VARIABLE rc OUTPUT_VARIABLE so ERROR_VARIABLE se)
  else()
    execute_process(COMMAND "${exe}" ${ARGN}
      RESULT_VARIABLE rc OUTPUT_VARIABLE so ERROR_VARIABLE se)
  endif()
  string(FIND "${so}${se}" "${PASSWORD}" leak)
  if(NOT leak EQUAL -1)
    message(SEND_ERROR "falhou: a senha apareceu na saida de: ${ARGN}")
  endif()
  set(${out_rc} "${rc}" PARENT_SCOPE)
  set(${out_text} "${so}${se}" PARENT_SCOPE)
endfunction()
macro(run_ahsign out_rc out_text input)
  run_prog(${out_rc} ${out_text} "${input}" "${AHSIGN}" ${ARGN})
endmacro()

# 1. Gerar (o único Argon2id de custo cheio do teste).
string(TIMESTAMP _t0 "%s")
run_ahsign(rc out "${WORK_DIR}/pw.txt" generate --out "${WORK_DIR}/key.bin" --password-stdin)
string(TIMESTAMP _t1 "%s")
math(EXPR _gen_s "${_t1} - ${_t0}")
message(STATUS "generate com custo cheio: ~${_gen_s} s")
check("rc EQUAL 0" "generate devolveu ${rc}: ${out}")
string(REGEX MATCH "key_id: ([0-9a-f]+)" _m "${out}")
set(KEY_ID "${CMAKE_MATCH_1}")
string(REGEX MATCH "public_key: ([0-9a-f]+)" _m "${out}")
set(PUBLIC_KEY "${CMAKE_MATCH_1}")
string(LENGTH "${KEY_ID}" _len_id)
string(LENGTH "${PUBLIC_KEY}" _len_pk)
check("_len_id EQUAL 16" "key_id impresso com 16 hex (veio '${KEY_ID}')")
check("_len_pk EQUAL 64" "public_key impressa com 64 hex (veio '${PUBLIC_KEY}')")
check("EXISTS \"${WORK_DIR}/key.bin\"" "key.bin criado")
file(SIZE "${WORK_DIR}/key.bin" _size)
check("_size EQUAL 153" "key.bin com 153 bytes (veio ${_size})")
file(READ "${WORK_DIR}/key.bin" _head LIMIT 24 HEX)
check("_head STREQUAL _magic_hex" "key.bin começa pelo cabeçalho fixo")
file(READ "${WORK_DIR}/key.bin" _pk_in_file OFFSET 73 LIMIT 32 HEX)
check("_pk_in_file STREQUAL PUBLIC_KEY" "chave pública impressa = a do arquivo")
# Custo cheio gravado: 256 MiB (0x00040000 LE) e 3 passadas.
file(READ "${WORK_DIR}/key.bin" _cost OFFSET 25 LIMIT 8 HEX)
check("_cost STREQUAL \"0000040003000000\"" "custo padrão gravado (veio ${_cost})")

# 2. Não sobrescreve uma chave existente, e recusa antes de pedir a senha.
run_ahsign(rc out "${WORK_DIR}/pw.txt" generate --out "${WORK_DIR}/key.bin" --password-stdin)
check("rc EQUAL 1" "generate sobre arquivo existente recusado (rc ${rc})")
string(FIND "${out}" "ja existe" _pos)
check("NOT _pos EQUAL -1" "motivo: arquivo já existe")
file(READ "${WORK_DIR}/key.bin" _pk_after OFFSET 73 LIMIT 32 HEX)
check("_pk_after STREQUAL PUBLIC_KEY" "chave existente intacta")

# 3. Senha vazia e senha por argv: recusadas.
run_ahsign(rc out "${WORK_DIR}/empty.txt" generate --out "${WORK_DIR}/k2.bin" --password-stdin)
check("rc EQUAL 1" "senha vazia recusada (rc ${rc})")
check("NOT EXISTS \"${WORK_DIR}/k2.bin\"" "nada gravado com senha vazia")
run_ahsign(rc out "" generate --out "${WORK_DIR}/k3.bin" --password "${PASSWORD}")
check("rc EQUAL 2" "--password por argv não existe (rc ${rc})")
check("NOT EXISTS \"${WORK_DIR}/k3.bin\"" "nada gravado com --password")

# 4. Arquivo de custo baixo, selado pelo núcleo (auxiliar de teste).
run_prog(rc out "${WORK_DIR}/pw.txt" "${FIXTURE}" "${WORK_DIR}/fix.bin")
check("rc EQUAL 0" "auxiliar gravou fix.bin (rc ${rc}: ${out})")
file(READ "${WORK_DIR}/fix.bin" FIX_PK OFFSET 73 LIMIT 32 HEX)

# 5. Exportar a chave pública como inicializador C; avisa do custo baixo.
run_ahsign(rc out "${WORK_DIR}/pw.txt" public --key "${WORK_DIR}/fix.bin" --name k_teste --password-stdin)
check("rc EQUAL 0" "public devolveu ${rc}: ${out}")
string(REGEX MATCH "/\\* k_teste: key_id ([0-9a-f]+)" _m "${out}")
set(FIX_ID "${CMAKE_MATCH_1}")
string(LENGTH "${FIX_ID}" _len_fix_id)
check("_len_fix_id EQUAL 16" "public mostra o key_id")
string(SUBSTRING "${FIX_PK}" 0 2 _b0)
string(SUBSTRING "${FIX_PK}" 2 2 _b1)
string(FIND "${out}" ".public_key = {\n        0x${_b0}, 0x${_b1}," _pos)
check("NOT _pos EQUAL -1" "public mostra os bytes da chave")
string(FIND "${out}" "abaixo do padrao" _pos)
check("NOT _pos EQUAL -1" "aviso de custo do Argon2id abaixo do padrão")
run_ahsign(rc out "${WORK_DIR}/wrong.txt" public --key "${WORK_DIR}/fix.bin" --password-stdin)
check("rc EQUAL 1" "public com senha errada recusado (rc ${rc})")

# 6. Assinar com senha errada: recusa e não grava.
run_ahsign(rc out "${WORK_DIR}/wrong.txt" sign --key "${WORK_DIR}/fix.bin"
  --body "${WORK_DIR}/body.json" --out "${WORK_DIR}/bad.manifest" --password-stdin)
check("rc EQUAL 1" "sign com senha errada recusado (rc ${rc})")
check("NOT EXISTS \"${WORK_DIR}/bad.manifest\"" "nada gravado com senha errada")

# 7. Assinar.
run_ahsign(rc out "${WORK_DIR}/pw.txt" sign --key "${WORK_DIR}/fix.bin"
  --body "${WORK_DIR}/body.json" --out "${WORK_DIR}/env.manifest" --password-stdin)
check("rc EQUAL 0" "sign devolveu ${rc}: ${out}")
string(FIND "${out}" "assinado: key_id ${FIX_ID}" _pos)
check("NOT _pos EQUAL -1" "sign usa a mesma chave que public mostrou")
file(READ "${WORK_DIR}/env.manifest" _env)
string(FIND "${_env}" "agents-hub-update-v1\nkey: ${FIX_ID}\nsig: " _pos)
check("_pos EQUAL 0" "envelope começa pelo cabeçalho com o key_id")
string(LENGTH "${_env}" _env_len)
string(LENGTH "${BODY}" _body_len)
math(EXPR _expected_len "178 + ${_body_len}")
check("_env_len EQUAL _expected_len" "envelope = 178 bytes de cabeçalho + corpo")
string(FIND "${_env}" "\n\n${BODY}" _pos)
math(EXPR _body_start "${_env_len} - ${_body_len} - 2")
check("_pos EQUAL _body_start" "corpo intacto no fim do envelope")
string(FIND "${_env}" "${_magic}" _pos)
check("_pos EQUAL -1" "envelope sem o cabeçalho do arquivo de chave")

# 8. Verificar: aceita.
run_ahsign(rc out "" verify --public-key "${FIX_PK}" --in "${WORK_DIR}/env.manifest")
check("rc EQUAL 0" "verify do envelope bom devolveu ${rc}: ${out}")
string(FIND "${out}" "ok: key_id ${FIX_ID}" _pos)
check("NOT _pos EQUAL -1" "verify mostra o key_id")

# 9. Envelope adulterado (um byte do corpo): recusa.
string(REPLACE "\"0.1.0\"" "\"0.1.1\"" _tampered "${_env}")
check("NOT _tampered STREQUAL _env" "adulteração aplicada")
file(WRITE "${WORK_DIR}/tampered.manifest" "${_tampered}")
run_ahsign(rc out "" verify --public-key "${FIX_PK}" --in "${WORK_DIR}/tampered.manifest")
check("rc EQUAL 1" "verify do envelope adulterado recusado (rc ${rc})")

# 10. Outra chave (fixa, RFC 8032) e a chave gerada no passo 1: recusam.
run_ahsign(rc out "" verify --public-key "${RFC_TEST1_PK}" --in "${WORK_DIR}/env.manifest")
check("rc EQUAL 1" "verify com outra chave recusado (rc ${rc})")
string(FIND "${out}" "outra chave" _pos)
check("NOT _pos EQUAL -1" "motivo: assinado por outra chave")
run_ahsign(rc out "" verify --public-key "${PUBLIC_KEY}" --in "${WORK_DIR}/env.manifest")
check("rc EQUAL 1" "verify com a chave do passo 1 recusado (rc ${rc})")

# 10b. Chave pública de ordem pequena (y = 0 e identidade): recusada antes de
# ler o envelope (SEC-R17); a forja com ela é coberta em test_update_verify.c.
set(_zero32 "0000000000000000000000000000000000000000000000000000000000000000")
set(_ident32 "0100000000000000000000000000000000000000000000000000000000000000")
foreach(_weak "${_zero32}" "${_ident32}")
  run_ahsign(rc out "" verify --public-key "${_weak}" --in "${WORK_DIR}/env.manifest")
  check("rc EQUAL 1" "verify com chave de ordem pequena recusado (rc ${rc})")
  string(FIND "${out}" "ordem pequena" _pos)
  check("NOT _pos EQUAL -1" "motivo: chave de ordem pequena (${_weak})")
endforeach()

# 11. Não sobrescreve o envelope (recusa antes de pedir a senha).
run_ahsign(rc out "${WORK_DIR}/pw.txt" sign --key "${WORK_DIR}/fix.bin"
  --body "${WORK_DIR}/body.json" --out "${WORK_DIR}/env.manifest" --password-stdin)
check("rc EQUAL 1" "sign sobre envelope existente recusado (rc ${rc})")
string(FIND "${out}" "ja existe" _pos)
check("NOT _pos EQUAL -1" "motivo: envelope já existe")

file(REMOVE_RECURSE "${WORK_DIR}")
if(_failures GREATER 0)
  message(FATAL_ERROR "ahsign_roundtrip: ${_failures} falha(s)")
endif()
message(STATUS "ahsign_roundtrip: ok")
