import os

def unificar_archivos_texto(archivo_salida="resultado_unificado.txt"):
    # Obtener el directorio donde se está ejecutando el script
    directorio_actual = os.getcwd()
    
    # Nombre de este script para evitar leerlo
    nombre_script = os.path.basename(__file__)

    print(f"Buscando archivos en: {directorio_actual}\n")

    try:
        with open(archivo_salida, "w", encoding="utf-8") as salida:
            for archivo in os.listdir(directorio_actual):
                # Validar que sea un archivo y no carpetas, el script o el resultado
                if (
                    os.path.isfile(archivo) 
                    and archivo != nombre_script 
                    and archivo != archivo_salida
                ):
                    # Opcional: Filtrar solo por ciertas extensiones (ej. .txt, .py, .md)
                    # Si quieres leer TODO, quita las líneas de la extensión
                    extensiones_permitidas = ('.txt', '.md', '.py', '.json', '.csv', '.js', '.html', '.css')
                    if not archivo.endswith(extensiones_permitidas):
                        continue

                    print(f"Leyendo: {archivo}...")
                    
                    # Escribir un encabezado para saber de qué archivo viene el texto
                    salida.write(f"\n{'='*40}\n")
                    salida.write(f"ARCHIVO: {archivo}\n")
                    salida.write(f"{'='*40}\n\n")
                    
                    # Leer el contenido del archivo e insertarlo en el de salida
                    try:
                        with open(archivo, "r", encoding="utf-8") as f:
                            salida.write(f.read())
                            salida.write("\n")  # Línea en blanco al final
                    except Exception as e:
                        salida.write(f"[ERROR: No se pudo leer este archivo. Motivo: {e}]\n")
                        
        print(f"\n¡Listo! Todo el texto se ha guardado en: {archivo_salida}")
        
    except Exception as e:
        print(f"Ocurrió un error al crear el archivo de salida: {e}")

if __name__ == "__main__":
    unificar_archivos_texto()