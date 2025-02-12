const { exec } = require("child_process");
const fs = require("fs");
const util = require("util");
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const execPromise = util.promisify(exec);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const OUTPUT_FILE = "dispositivos_red.txt";
const CAPTURE_TIME = 5; // Segundos de captura de tráfico
const ALERT_THRESHOLD = 500; // kbps (límite para alertas)

// Servir archivos estáticos (Frontend)
app.use(express.static("public"));

// Obtener la interfaz de red activa
async function obtenerInterfaz() {
    const salida = await ejecutarComando("ip route | grep default");
    if (!salida) return null;
    const match = salida.match(/dev (\w+)/);
    return match ? match[1] : null;
}

// Función para ejecutar comandos en la terminal
async function ejecutarComando(cmd) {
    try {
        const { stdout } = await execPromise(cmd);
        return stdout;
    } catch (error) {
        console.error(`Error ejecutando ${cmd}:`, error);
        return null;
    }
}

// Escanear la red en busca de dispositivos con `arp-scan`
async function escanearRed(interfaz) {
    console.log("🔍 Escaneando la red en busca de dispositivos...");
    const salida = await ejecutarComando(`sudo arp-scan -l --interface=${interfaz}`);
    const dispositivos = [];

    // Extraer IPs y MACs
    const regex = /(\d+\.\d+\.\d+\.\d+)\s+([\w:]+)/g;
    let match;
    while ((match = regex.exec(salida)) !== null) {
        dispositivos.push({ ip: match[1], mac: match[2], bandwidth: "0 kbps" });
    }
    return dispositivos;
}

// Medir el tráfico de cada IP con `tcpdump`
async function medirAnchoDeBanda(interfaz, dispositivos) {
    console.log(`📡 Midiendo tráfico de red en ${interfaz} durante ${CAPTURE_TIME} segundos...`);
    
    const cmd = `sudo timeout ${CAPTURE_TIME} tcpdump -i ${interfaz} -n -q -tt | awk '{print $3, $NF}'`;
    const salida = await ejecutarComando(cmd);
    
    if (!salida) return dispositivos;

    const trafico = {}; // Objeto para almacenar tráfico por IP
    const alertas = [];

    // Analizar el tráfico capturado
    const lineas = salida.split("\n");
    lineas.forEach(linea => {
        const partes = linea.split(" ");
        if (partes.length < 2) return;

        let ip = partes[0].split(".").slice(0, 4).join(".");
        let tamano = parseInt(partes[1]);

        if (!isNaN(tamano) && ip.match(/^\d+\.\d+\.\d+$/)) {
            trafico[ip] = (trafico[ip] || 0) + tamano;
        }
    });

    // Calcular ancho de banda por IP
    dispositivos.forEach(dispositivo => {
        const totalBytes = trafico[dispositivo.ip] || 0;
        const kbps = ((totalBytes * 8) / (CAPTURE_TIME * 1024)).toFixed(2); // Convertir a kbps
        dispositivo.bandwidth = `${kbps} kbps`;

        if (parseFloat(kbps) > ALERT_THRESHOLD) {
            alertas.push({ ip: dispositivo.ip, mac: dispositivo.mac, bandwidth: kbps });
        }
    });

    return { dispositivos, alertas };
}

// Función principal
async function monitorearRed() {
    const interfaz = await obtenerInterfaz();
    if (!interfaz) {
        console.error("⚠ No se pudo detectar la interfaz de red.");
        return;
    }

    while (true) {
        const dispositivos = await escanearRed(interfaz);
        if (dispositivos.length === 0) {
            console.log("❌ No se encontraron dispositivos en la red.");
            continue;
        }

        const { dispositivos: actualizados, alertas } = await medirAnchoDeBanda(interfaz, dispositivos);

        // Guardar en archivo
        let contenido = "IP Address\tMAC Address\tBandwidth\n";
        actualizados.forEach(dispositivo => {
            contenido += `${dispositivo.ip}\t${dispositivo.mac}\t${dispositivo.bandwidth}\n`;
        });

        fs.writeFileSync(OUTPUT_FILE, contenido, "utf-8");

        // Emitir datos a la interfaz web
        io.emit("update", { dispositivos: actualizados, alertas });

        console.log("✅ Datos actualizados.");
        await new Promise(resolve => setTimeout(resolve, CAPTURE_TIME * 1000));
    }
}

// Iniciar servidor y monitoreo
server.listen(3000, () => {
    console.log("🚀 Servidor web en http://localhost:3000");
    monitorearRed();
});
