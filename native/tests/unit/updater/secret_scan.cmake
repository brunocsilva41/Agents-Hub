# T14 da proposta F8-04 §8 / SEC-R22: nenhum material de chave privada no
# repositório, nos workflows nem no executável do produto.
#
# Procura o cabeçalho fixo do arquivo de chave privada da ferramenta ahsign
# (native/tools/ahsign/ahsign_key.h) em:
#   - todo arquivo rastreado pelo git e todo arquivo novo ainda não rastreado e
#     não ignorado (git grep --untracked), lido como bytes, inclusive binários;
#   - todo arquivo em .github/workflows/, mesmo se ignorado;
#   - os arquivos de EXTRA_FILES (o executável `hub`).
# Falha se achar o cabeçalho fora da lista de permitidos, se o git faltar, ou
# se o controle positivo (um arquivo plantado com o cabeçalho) não for achado.
#
# Uso: cmake -DGIT=<git> -DREPO_ROOT=<raiz> -DWORK_DIR=<dir> [-DEXTRA_FILES=a;b] -P este-arquivo
#
# O cabeçalho é montado por partes: este arquivo não o contém literal.
cmake_minimum_required(VERSION 3.22)

string(CONCAT MAGIC "agents-hub-" "secret-" "key-v1")

# Únicos arquivos que podem conter o texto, relativos à raiz do repositório:
# a definição da constante e a proposta F8-04 (que só nomeia o cabeçalho).
set(ALLOWED
  "native/tools/ahsign/ahsign_key.c"
  "docs/propostas/F8-04-chave-e-manifesto-de-atualizacao.md")

if(NOT GIT OR NOT EXISTS "${GIT}")
  message(FATAL_ERROR "secret_scan: git não encontrado ('${GIT}'); a varredura não pode ser pulada")
endif()
if(NOT REPO_ROOT OR NOT EXISTS "${REPO_ROOT}/.git")
  message(FATAL_ERROR "secret_scan: REPO_ROOT não é a raiz de um checkout git: '${REPO_ROOT}'")
endif()
get_filename_component(REPO_ROOT "${REPO_ROOT}" REALPATH)
if(NOT WORK_DIR)
  message(FATAL_ERROR "secret_scan: WORK_DIR ausente")
endif()

# Lista de caminhos (relativos a `dir`) que contêm MAGIC, via git grep.
# -F texto fixo; -l só o nome; sem -I: binários também contam.
function(git_grep_files out_var dir)
  execute_process(
    COMMAND "${GIT}" -c core.quotePath=false grep -l -F ${ARGN} -e "${MAGIC}"
    WORKING_DIRECTORY "${dir}"
    RESULT_VARIABLE rc OUTPUT_VARIABLE so ERROR_VARIABLE se)
  if(rc EQUAL 1)
    set(${out_var} "" PARENT_SCOPE) # nada encontrado
    return()
  endif()
  if(NOT rc EQUAL 0)
    message(FATAL_ERROR "secret_scan: git grep falhou (${rc}): ${se}")
  endif()
  string(REPLACE "\r" "" so "${so}")
  string(STRIP "${so}" so)
  string(REPLACE "\n" ";" files "${so}")
  set(${out_var} "${files}" PARENT_SCOPE)
endfunction()

# Verdadeiro se o arquivo contém MAGIC em qualquer posição de byte.
string(HEX "${MAGIC}" MAGIC_HEX)
function(file_has_magic out_var path)
  file(READ "${path}" content HEX)
  set(start 0)
  set(found 0)
  while(TRUE)
    string(SUBSTRING "${content}" ${start} -1 rest)
    string(FIND "${rest}" "${MAGIC_HEX}" pos)
    if(pos EQUAL -1)
      break()
    endif()
    math(EXPR abs "${start} + ${pos}")
    math(EXPR odd "${abs} % 2")
    if(odd EQUAL 0) # alinhado a byte (2 dígitos hex por byte)
      set(found 1)
      break()
    endif()
    math(EXPR start "${abs} + 1")
  endwhile()
  set(${out_var} ${found} PARENT_SCOPE)
endfunction()

set(_failures 0)

# Controle positivo: o mesmo método precisa achar um cabeçalho plantado,
# num arquivo binário e em posição ímpar, senão a varredura não prova nada.
file(REMOVE_RECURSE "${WORK_DIR}")
file(MAKE_DIRECTORY "${WORK_DIR}")
string(ASCII 1 2 3 _bin)
file(WRITE "${WORK_DIR}/plantado.bin" "${_bin}${MAGIC}\n")
git_grep_files(_ctl "${WORK_DIR}" --no-index)
list(FIND _ctl "plantado.bin" _idx)
if(_idx EQUAL -1)
  message(SEND_ERROR "secret_scan: controle positivo do git grep falhou (achou: '${_ctl}')")
  math(EXPR _failures "${_failures} + 1")
endif()
file_has_magic(_ctl_hex "${WORK_DIR}/plantado.bin")
if(NOT _ctl_hex)
  message(SEND_ERROR "secret_scan: controle positivo da leitura de bytes falhou")
  math(EXPR _failures "${_failures} + 1")
endif()
file(WRITE "${WORK_DIR}/limpo.txt" "agents-hub-secret-key\n")
file_has_magic(_ctl_clean "${WORK_DIR}/limpo.txt")
if(_ctl_clean)
  message(SEND_ERROR "secret_scan: falso positivo no controle negativo")
  math(EXPR _failures "${_failures} + 1")
endif()
file(REMOVE_RECURSE "${WORK_DIR}")

# 1. Repositório: rastreados + novos não ignorados.
git_grep_files(_hits "${REPO_ROOT}" --untracked)
set(_seen_definition 0)
foreach(_f IN LISTS _hits)
  list(FIND ALLOWED "${_f}" _idx)
  if(_idx EQUAL -1)
    message(SEND_ERROR "secret_scan: cabeçalho de chave privada em ${_f}")
    math(EXPR _failures "${_failures} + 1")
  elseif(_f STREQUAL "native/tools/ahsign/ahsign_key.c")
    set(_seen_definition 1)
  endif()
endforeach()
# A definição da constante tem de aparecer: prova que a busca rodou de fato no repositório.
if(NOT _seen_definition)
  message(SEND_ERROR "secret_scan: a definição em native/tools/ahsign/ahsign_key.c não foi achada; a varredura não está olhando o repositório")
  math(EXPR _failures "${_failures} + 1")
endif()

# 2. Workflows, inclusive arquivos ignorados pelo git.
file(GLOB_RECURSE _workflows LIST_DIRECTORIES false "${REPO_ROOT}/.github/workflows/*")
foreach(_f IN LISTS _workflows)
  file_has_magic(_has "${_f}")
  if(_has)
    message(SEND_ERROR "secret_scan: cabeçalho de chave privada no workflow ${_f}")
    math(EXPR _failures "${_failures} + 1")
  endif()
endforeach()

# 3. Executáveis do produto.
foreach(_f IN LISTS EXTRA_FILES)
  if(NOT EXISTS "${_f}")
    message(SEND_ERROR "secret_scan: artefato inexistente: ${_f}")
    math(EXPR _failures "${_failures} + 1")
    continue()
  endif()
  file_has_magic(_has "${_f}")
  if(_has)
    message(SEND_ERROR "secret_scan: cabeçalho de chave privada no artefato ${_f}")
    math(EXPR _failures "${_failures} + 1")
  endif()
endforeach()

list(LENGTH _hits _n_hits)
list(LENGTH _workflows _n_wf)
list(LENGTH EXTRA_FILES _n_extra)
if(_failures GREATER 0)
  message(FATAL_ERROR "secret_scan: ${_failures} falha(s)")
endif()
message(STATUS "secret_scan: ok (ocorrências permitidas: ${_n_hits}; workflows: ${_n_wf}; artefatos: ${_n_extra})")
