/* Executável de conformidade de exemplo: mostra o formato que cada módulo
 * usa (`<exe> <arquivo.jsonl>`, registrado com ah_add_conformance_test). */
#include "exemplo_suite.h"

int main(int argc, char **argv) {
    return ah_conformance_main(argc, argv, ah_conformance_exemplo_suite());
}
