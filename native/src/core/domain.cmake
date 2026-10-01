# Fragmento de ah_core: ids, tempo, erros e tipos de domínio (tarefa F1-01,
# plano docs/17). Incluído por native/src/core/CMakeLists.txt.
#
# ah_unicode_tables.h é gerado a partir do Node (o gerador está no fim do
# próprio arquivo) e versionado: o build não depende do Node.
list(APPEND AH_CORE_SOURCES
  ah_sha256.c
  ah_unicode.c
  ah_ids.c
  ah_errors.c
  ah_domain.c)
