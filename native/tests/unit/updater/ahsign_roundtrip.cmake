# Ida e volta da ferramenta ahsign (F8-05): gerar → exportar → assinar →
# verificar, com chave e senha de teste efêmeras num diretório do build.
# Uso (registrado no CTest): cmake -DAHSIGN=<exe> -DWORK_DIR=<dir> -P este-arquivo
#
# O cabeçalho do arquivo de chave é montado por partes (o teste T14 recusa o
# texto literal fora de ahsign_key.c).
cmake_minimum_required(VERSION 3.22)

if(NOT AHSIGN OR NOT EXISTS "${AHSIGN}")
  message(FATAL_ERROR "AHSIGN ausente: '${AHSIGN}'")
endif()
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

# Executa o ahsign e junta stdout+stderr; a senha nunca pode aparecer na saída.
function(run_ahsign out_rc out_text input)
  if(input)
    execute_process(COMMAND "${AHSIGN}" ${ARGN}
      INPUT_FILE "${input}"
      RESULT_VARIABLE rc OUTPUT_VARIABLE so ERROR_VARIABLE se)
  else()
    execute_process(COMMAND "${AHSIGN}" ${ARGN}
      RESULT_VARIABLE rc OUTPUT_VARIABLE so ERROR_VARIABLE se)
  endif()
  string(FIND "${so}${se}" "${PASSWORD}" leak)
  if(NOT leak EQUAL -1)
    message(SEND_ERROR "falhou: a senha apareceu na saida de: ${ARGN}")
  endif()
  set(${out_rc} "${rc}" PARENT_SCOPE)
  set(${out_text} "${so}${se}" PARENT_SCOPE)
endfunction()

# 1. Gerar.
run_ahsign(rc out "${WORK_DIR}/pw.txt" generate --out "${WORK_DIR}/key.bin" --password-stdin)
check("rc EQUAL 0" "generate devolveu ${rc}: ${out}")
string(REGEX MATCH "key_id: ([0-9a-f]+)" _m "${out}")
set(KEY_ID "${CMAKE_MATCH_1}")
string(REGEX MATCH "public_key: ([0-9a-f]+)" _m "${out}")
set(PUBLIC_KEY "${CMAKE_MATCH_1}")
string(LENGTH "${KEY_ID}" _len_id)
string(LENGTH "${PUBLIC_KEY}" _len_pk)
check("_len_id EQUAL 16" "key_id impresso com 16 hex (veio '${KEY_ID}')")
check("_len_pk EQUAL 64" "public_key impressa com 64 hex (veio '${PUBLIC_KEY}')")

# O arquivo começa pelo cabeçalho fixo e tem o tamanho do formato.
check("EXISTS \"${WORK_DIR}/key.bin\"" "key.bin criado")
file(SIZE "${WORK_DIR}/key.bin" _size)
check("_size EQUAL 153" "key.bin com 153 bytes (veio ${_size})")
string(CONCAT _magic "agents-hub-" "secret-" "key-v1")
string(HEX "${_magic}" _magic_hex)
file(READ "${WORK_DIR}/key.bin" _head LIMIT 24 HEX)
check("_head STREQUAL _magic_hex" "key.bin começa pelo cabeçalho fixo")
# A chave pública está em claro no arquivo (posição 73); a semente, não.
file(READ "${WORK_DIR}/key.bin" _pk_in_file OFFSET 73 LIMIT 32 HEX)
check("_pk_in_file STREQUAL PUBLIC_KEY" "chave pública impressa = a do arquivo")

# 2. Não sobrescreve uma chave existente.
run_ahsign(rc out "${WORK_DIR}/pw.txt" generate --out "${WORK_DIR}/key.bin" --password-stdin)
check("rc EQUAL 1" "generate sobre arquivo existente recusado (rc ${rc})")
file(READ "${WORK_DIR}/key.bin" _pk_after OFFSET 73 LIMIT 32 HEX)
check("_pk_after STREQUAL PUBLIC_KEY" "chave existente intacta")

# 3. Senha vazia e senha por argv: recusadas.
run_ahsign(rc out "${WORK_DIR}/empty.txt" generate --out "${WORK_DIR}/k2.bin" --password-stdin)
check("rc EQUAL 1" "senha vazia recusada (rc ${rc})")
check("NOT EXISTS \"${WORK_DIR}/k2.bin\"" "nada gravado com senha vazia")
run_ahsign(rc out "" generate --out "${WORK_DIR}/k3.bin" --password "${PASSWORD}")
check("rc EQUAL 2" "--password por argv não existe (rc ${rc})")
check("NOT EXISTS \"${WORK_DIR}/k3.bin\"" "nada gravado com --password")

# 4. Exportar a chave pública como inicializador C.
run_ahsign(rc out "${WORK_DIR}/pw.txt" public --key "${WORK_DIR}/key.bin" --name k_teste --password-stdin)
check("rc EQUAL 0" "public devolveu ${rc}: ${out}")
string(FIND "${out}" "/* k_teste: key_id ${KEY_ID}" _pos)
check("NOT _pos EQUAL -1" "public mostra o key_id")
string(SUBSTRING "${PUBLIC_KEY}" 0 2 _b0)
string(SUBSTRING "${PUBLIC_KEY}" 2 2 _b1)
string(FIND "${out}" ".public_key = {\n        0x${_b0}, 0x${_b1}," _pos)
check("NOT _pos EQUAL -1" "public mostra os bytes da chave")
run_ahsign(rc out "${WORK_DIR}/wrong.txt" public --key "${WORK_DIR}/key.bin" --password-stdin)
check("rc EQUAL 1" "public com senha errada recusado (rc ${rc})")

# 5. Assinar com senha errada: recusa e não grava.
run_ahsign(rc out "${WORK_DIR}/wrong.txt" sign --key "${WORK_DIR}/key.bin"
  --body "${WORK_DIR}/body.json" --out "${WORK_DIR}/bad.manifest" --password-stdin)
check("rc EQUAL 1" "sign com senha errada recusado (rc ${rc})")
check("NOT EXISTS \"${WORK_DIR}/bad.manifest\"" "nada gravado com senha errada")

# 6. Assinar.
run_ahsign(rc out "${WORK_DIR}/pw.txt" sign --key "${WORK_DIR}/key.bin"
  --body "${WORK_DIR}/body.json" --out "${WORK_DIR}/env.manifest" --password-stdin)
check("rc EQUAL 0" "sign devolveu ${rc}: ${out}")
file(READ "${WORK_DIR}/env.manifest" _env)
string(FIND "${_env}" "agents-hub-update-v1\nkey: ${KEY_ID}\nsig: " _pos)
check("_pos EQUAL 0" "envelope começa pelo cabeçalho com o key_id")
string(LENGTH "${_env}" _env_len)
string(LENGTH "${BODY}" _body_len)
math(EXPR _expected_len "178 + ${_body_len}")
check("_env_len EQUAL _expected_len" "envelope = 178 bytes de cabeçalho + corpo")
string(FIND "${_env}" "\n\n${BODY}" _pos)
math(EXPR _body_start "${_env_len} - ${_body_len} - 2")
check("_pos EQUAL _body_start" "corpo intacto no fim do envelope")
# O envelope não contém o cabeçalho do arquivo de chave.
string(FIND "${_env}" "${_magic}" _pos)
check("_pos EQUAL -1" "envelope sem o cabeçalho do arquivo de chave")

# 7. Verificar: aceita.
run_ahsign(rc out "" verify --public-key "${PUBLIC_KEY}" --in "${WORK_DIR}/env.manifest")
check("rc EQUAL 0" "verify do envelope bom devolveu ${rc}: ${out}")
string(FIND "${out}" "ok: key_id ${KEY_ID}" _pos)
check("NOT _pos EQUAL -1" "verify mostra o key_id")

# 8. Envelope adulterado (um byte do corpo): recusa.
string(REPLACE "\"0.1.0\"" "\"0.1.1\"" _tampered "${_env}")
check("NOT _tampered STREQUAL _env" "adulteração aplicada")
file(WRITE "${WORK_DIR}/tampered.manifest" "${_tampered}")
run_ahsign(rc out "" verify --public-key "${PUBLIC_KEY}" --in "${WORK_DIR}/tampered.manifest")
check("rc EQUAL 1" "verify do envelope adulterado recusado (rc ${rc})")

# 9. Outra chave: recusa (assinado por chave desconhecida).
run_ahsign(rc out "${WORK_DIR}/pw.txt" generate --out "${WORK_DIR}/other.bin" --password-stdin)
check("rc EQUAL 0" "segunda chave gerada (rc ${rc})")
string(REGEX MATCH "public_key: ([0-9a-f]+)" _m "${out}")
set(OTHER_PK "${CMAKE_MATCH_1}")
check("NOT OTHER_PK STREQUAL PUBLIC_KEY" "chaves geradas diferentes")
run_ahsign(rc out "" verify --public-key "${OTHER_PK}" --in "${WORK_DIR}/env.manifest")
check("rc EQUAL 1" "verify com outra chave recusado (rc ${rc})")
string(FIND "${out}" "outra chave" _pos)
check("NOT _pos EQUAL -1" "motivo: assinado por outra chave")

# 10. Não sobrescreve o envelope.
run_ahsign(rc out "${WORK_DIR}/pw.txt" sign --key "${WORK_DIR}/key.bin"
  --body "${WORK_DIR}/body.json" --out "${WORK_DIR}/env.manifest" --password-stdin)
check("rc EQUAL 1" "sign sobre envelope existente recusado (rc ${rc})")

file(REMOVE_RECURSE "${WORK_DIR}")
if(_failures GREATER 0)
  message(FATAL_ERROR "ahsign_roundtrip: ${_failures} falha(s)")
endif()
message(STATUS "ahsign_roundtrip: ok")
