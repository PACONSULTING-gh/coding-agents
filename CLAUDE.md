# CLAUDE.md — Constitución del proyecto

> Este archivo se carga en el contexto de todo agente que trabaje en este repo.
> Es la capa de **guía**. La capa que de verdad obliga son los hooks de pre-commit
> y el CI (ver `docs/quality-gates.md`). Si una regla de aquí importa de verdad,
> tiene que existir también como check determinista.

---

## 1. Qué estamos construyendo

Una capa de coordinación de equipos que se sienta ENCIMA de GitHub Issues, CCPM
y agentes de código (Claude Code, Codex, Copilot CLI). Resuelve tres cosas que
hoy no resuelve nadie:

1. Repartir tareas entre **personas** (no solo entre subagentes de una persona).
2. Evitar que agentes de **distintos desarrolladores** dupliquen o colisionen.
3. Permitir supervisar el trabajo de un agente **sin leer el diff**.

Uso dual: herramienta interna de Liberion Labs para sus proyectos de cliente,
y producto vendible a otros equipos.

**Regla de alcance:** si una feature no sirve a uno de esos tres problemas,
no entra en la v1.

---

## 2. Principios innegociables

### 2.1 El humano decide
Los agentes **proponen**, nunca deciden. Esto aplica a:
- Asignación de tareas → el router sugiere, un humano confirma.
- Cambios de infraestructura → el agente genera el plan, un humano aplica.
- Merge a main → el gate automático puede bloquear, nunca aprobar solo.

Ningún agente tiene permiso para aprobar su propio trabajo ni el de otro agente.

### 2.2 Trazabilidad total
Toda línea de código se remonta a una especificación. Cadena obligatoria:

```
Discovery → PRD → Epic → Task → GitHub Issue → Commit
```

Convención de commit: `Issue #N: descripción`. Sin issue, no hay commit.

### 2.3 El verificador nunca es el generador
El agente que escribe el código **jamás** verifica su propio trabajo. El Verifier
corre en un contexto limpio, ve solo el spec y el diff final, nunca el razonamiento
del que codeó. Preferiblemente otro modelo.

### 2.4 Pereza en la solución, nunca en la lectura
Antes de escribir código, el agente baja por esta escalera y para en el primer
peldaño que aguante:

```
1. ¿Hace falta que exista?        → no: no lo escribas (YAGNI)
2. ¿Ya está en este repo?         → reutilízalo
3. ¿Lo hace la stdlib?            → úsala
4. ¿Feature nativa de plataforma? → úsala
5. ¿Dependencia ya instalada?     → úsala
6. ¿Cabe en una línea?            → una línea
7. Solo entonces: el mínimo que funciona
```

La escalera se aplica DESPUÉS de entender el problema, no en lugar de entenderlo.
Leer el código que se toca y trazar el flujo real es obligatorio.

**Nunca recortable, en ningún peldaño:** validación en fronteras de confianza,
manejo de pérdida de datos, seguridad, accesibilidad.

(Esto está automatizado vía el plugin `ponytail` — ver `docs/agent-stack.md`.)

### 2.5 Seguridad desde el minuto uno
No se retrofitea. El pipeline arranca ya con: escaneo de secretos, SCA de
dependencias, SAST, y escaneo de IaC. Ver `docs/quality-gates.md`.

Toda dependencia que proponga un agente se verifica que **existe realmente**
antes de commitear (riesgo de paquetes alucinados).

### 2.6 Multi-tenant desde el diseño
Cada fila tiene `tenant_id`. RLS forzada en Postgres. Ningún query sin scope
de tenant. Tests explícitos de aislamiento entre tenants.

---

## 3. Arquitectura — decisiones ya tomadas

No las re-litigues. Si crees que una está mal, abre un ADR proponiendo el cambio.

| Decisión | Elección | Por qué |
|---|---|---|
| Integración GitHub | GitHub App (no OAuth App) | Sobrevive a que se vaya quien la instaló; tokens de 1h; permisos finos |
| Base de datos | Postgres, esquema compartido + RLS forzada | Escala a cientos de miles de tenants; menor coste operativo |
| Cola de trabajos | pg-boss sobre el mismo Postgres | Sin Redis. Detrás de una interfaz para poder cambiar |
| Pool de conexiones | PgBouncer, modo transacción | El límite de conexiones es la primera pared que se toca |
| Grafo de dependencias | Postgres (adjacency list + recursive CTEs) | Gana a Neo4j ~4x en expansión de vecindario, que es el patrón que usamos |
| Motor de ejecución | CCPM + GitHub Issues | Issues como fuente de verdad; comentarios como audit trail |
| Heartbeats | Push desde el daemon local al hub | Los portátiles duermen y están tras NAT. Nunca polling del hub |
| Lenguaje backend | TypeScript / Node | Ecosistema de pg-boss, tree-sitter, MCP |
| Repo | Monorepo | 3 personas, dominio acoplado |

---

## 4. Lo que NO se construye todavía

Añadir cualquiera de estas cosas sin que se cumpla su disparador es
sobre-ingeniería y se rechaza en review:

| No construir | Disparador para reconsiderar |
|---|---|
| Redis / Kafka / bus de eventos | Miles de jobs/seg sostenidos |
| Base de datos por tenant | Cliente que lo exija por contrato |
| SSO / SAML / SCIM | Primer cliente enterprise que lo pida **por escrito** |
| SOC 2 / ISO 27001 | Venta enterprise real en el horizonte (proceso de 8-12 meses) |
| Base de datos de grafos (Neo4j) | Latencia p95 de las CTEs degradada y medida |
| Matching global (Hungaro) | Cuando el score ponderado sobrecargue demostrablemente a alguien |
| Plataforma de memoria organizacional | Cuando el dolor real sea preguntas multi-fuente sobre decisiones pasadas |

Sí se construye ya (barato ahora, caro después): abstracción de auth,
tabla `audit_log` append-only con API de lectura, RBAC real, columna
`tenant.database_url`, interfaz sobre la cola.

---

## 5. Convenciones de código

- **Arquitectura:** dependencias apuntan hacia dentro (dominio no conoce
  infraestructura). Enforced con fitness functions en CI, no por buena voluntad.
- **Sin ciclos** entre módulos. Enforced.
- **Tests:** cada criterio de aceptación tiene su test. Los tests los escribe
  un agente distinto al que escribió el código.
- **Nada de mocks de lo que no controlas** en tests de integración.
- **Errores:** nunca `catch` silencioso. Si no sabes qué hacer con el error,
  propágalo.
- **Secretos:** jamás en el repo. Ni en tests. Ni en fixtures.

---

## 6. Definition of Done

Una tarea está terminada cuando **todas** se cumplen:

- [ ] Existe el issue de GitHub y los commits lo referencian (`Issue #N:`)
- [ ] Los criterios de aceptación Given/When/Then estaban aprobados **antes** de codear
- [ ] Cada criterio tiene su test, y los tests pasan
- [ ] Build, lint, type-check y escaneos de seguridad en verde
- [ ] Umbral de mutation testing superado (en módulos críticos)
- [ ] Las fitness functions de arquitectura pasan
- [ ] El Verifier ha emitido informe de conformidad, en contexto limpio
- [ ] Un humano ha aprobado

"Los tests pasan" NO es Definition of Done por sí solo. Un agente puede haber
debilitado los tests. Por eso existe el mutation testing y el Verifier.

---

## 7. Señales de alarma que el agente debe reportar, no ocultar

Si te encuentras haciendo cualquiera de estas cosas, **para y escala a un humano**:

- Modificar o borrar un test para que pase el build.
- Hardcodear el valor esperado en vez de calcularlo.
- Añadir un `try/catch` que traga un error para que el flujo continúe.
- Necesitar una dependencia nueva que no está en la lista aprobada.
- Descubrir que el spec es ambiguo o imposible de cumplir tal como está escrito.

Decir "esto no se puede hacer como está pedido" es una respuesta correcta y
valorada. Fingir que funciona no lo es.
