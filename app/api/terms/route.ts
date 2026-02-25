import { NextResponse } from 'next/server';

import crypto from 'crypto';

// English terms
const termsTextEn: string = `# *ai.msf.org* Terms of Use

The MSF AI Assistant is an internal AI chatbot developed for MSF staff. It uses large language models within Microsoft Azure Foundry while keeping all data within MSF, ensuring privacy and control.

The AI Assistant can help you with everyday tasks such as writing text, summarizing documents, translating languages, and drafting emails or reports. It can also help with data analysis, brainstorming ideas, and finding quick answers to questions, making it a useful tool for daily work activities.

By using ai.msf.org, you agree with the following terms and conditions:

## Responsible use:

You agree you will use ai.msf.org responsibly. You will:

-   Use it in accordance with your MSF entities' applicable ICT, AI and other policies.

-   Always check outputs for accuracy, inclusivity and bias. Ai.msf.org uses experimental technology -- it gives no guarantee the outputs will be accurate. In addition, the technology has not been trained using data representative of MSF patients and communities. AI outputs can perpetuate bias, discrimination and stereotypes. You are responsible for checking the outputs produced.

-   Check outputs don't infringe third party intellectual property rights -- especially for anything used publicly. Like other generative AI systems, the technology behind ai.msf.org has been trained on third party intellectual property without clear permissions and licenses.

-   Be transparent about your AI use. Tell people if something you use has been produced by AI, and mark outputs as AI-generated.

**You will NOT use ai.msf.org for any of the following purposes:**

-   **Health care** *(to provide healthcare or answer health-related questions)*

-   **Surveillance or monitoring of MSF patients or communities or any other individual(s)**

-   **Employment-related decisions** *(to assist or replace employment-related decisions)*

-   **Automated decision-making** *(to make decisions that could be detrimental to an individual or community)*

-   **Creating media content for external communications on matters of public interest**

-   **Illegal or harmful activities**

## Privacy:

Using ai.msf.org is a safer and more secure environment than using other external free AI tools, which offer very little privacy guarantees. However, be aware there are still limits and caveats -- look at the usage policy for further details.

Like other Microsoft products, your login information will be processed by MSF as outlined in your MSF entity's privacy policy.

**You will NOT put into ai.msf.org prompts/ upload into it any the following information:**

-   **Sensitive Personal data** (this includes: Racial or Ethnic Origin, Sexual Orientation, Genetic Data or Biometric Data, Personal Financial information, Personal Health information, Political Opinions, Trade Union Membership, or Religious or Philosophical Beliefs.) Non-sensitive personal data, such as a name or email address, may be used in a prompt for general use, such as rewriting an email.

-   **Highly sensitive data** (data that can be intentionally or unintentionally used to harm individuals, communities, MSF or its staff -- determining the sensitivity of data requires incorporating context analysis e.g. locations of sensitive projects or at-risk groups, security incidents, and other operational details)

**If you plan to use personal data in the MSF AI Assistant as part of an existing business process, contact your DPO first.**

**If you wish to use an AI solution for support in managing or processing sensitive personal data or medical data, please contact the AI Team for advice.**

## Breaches / feedback

If you have any concerns, or want to notify an incident, please contact: [ai.team@amsterdam.msf.org](mailto:ai.team@amsterdam.msf.org)

These terms may be modified at any time by MSF -- we'll provide notice to you if we change them -- your continued use of ai.msf.org constitutes acceptance of any changes.`;

// French terms
const termsTextFr: string = `# *ai.msf.org* Conditions d'utilisation

L'Assistant IA MSF est un chatbot IA interne développé pour le personnel de MSF. Il utilise des modèles de langage avancés hébergés sur Microsoft Azure Foundry tout en gardant toutes les données au sein de MSF, garantissant ainsi confidentialité et contrôle.

L'Assistant IA peut vous aider dans vos tâches quotidiennes telles que la rédaction de textes, la synthèse de documents, la traduction de langues, ainsi que la rédaction d'e-mails ou de rapports. Il peut également vous assister dans l'analyse de données, la génération d'idées et la recherche de réponses rapides à vos questions, ce qui en fait un outil utile pour les activités professionnelles de tous les jours.

En utilisant ai.msf.org, vous acceptez les conditions suivantes :

## Utilisation responsable:

Vous acceptez d'utiliser ai.msf.org de manière responsable. Vous vous engagez à :

-   L'utiliser conformément aux politiques de securité de l'information, IA et autres politiques applicables de votre entité MSF.

-   Vérifier systématiquement l'exactitude, l'inclusivité et l'absence de biais des résultats. Ai.msf.org utilise une technologie expérimentale --- il n'y a aucune garantie que les résultats seront exacts. De plus, la technologie n'a pas été entraînée avec des données représentatives des patients et communautés MSF. Les résultats générés par l'IA peuvent contenir des biais, des discriminations ou des stéréotypes. Vous êtes responsable de la vérification des résultats produits.

-   Vérifier que les résultats ne portent pas atteinte aux droits de propriété intellectuelle de tiers --- en particulier pour tout usage public. Comme d'autres systèmes d'IA générative, la technologie derrière ai.msf.org a été entraînée sur des contenus tiers sans autorisations ou licences claires.

-   Être transparent sur votre utilisation de l'IA. Informez les personnes si un contenu que vous utilisez a été produit par l'IA, et identifiez les résultats comme générés par l'IA.

**Vous ne devez PAS utiliser ai.msf.org pour l'un des usages suivants:**

-   **Soins de santé** (pour fournir des soins ou répondre à des questions médicales)

-   **Surveillance ou suivi des patients**, communautés MSF ou toute autre personne

-   **Décisions liées à l'emploi** (pour assister ou remplacer des décisions liées à l'emploi)

-   **Prise de décision automatisée** (pour prendre des décisions susceptibles de nuire à une personne ou une communauté)

-   **Création de contenus médiatiques pour la communication externe sur des sujets d'intérêt public**

-   **Activités illégales ou préjudiciables**

## Confidentialité:

L'utilisation de ai.msf.org offre un environnement plus sûr et sécurisé que d'autres outils IA gratuits externes, qui offrent très peu de garanties en matière de confidentialité. Cependant, il existe encore des limites et mises en garde --- veuillez consulter la politique d'utilisation pour plus de détails.

Comme pour d'autres produits Microsoft, vos informations de connexion seront traitées par MSF conformément à la politique de confidentialité de votre entité MSF.

**Vous ne devez PAS saisir ou télécharger dans ai.msf.org les informations suivantes :**

-   **Données personnelles sensibles** (cela inclut : origine raciale ou ethnique, orientation sexuelle, données génétiques ou biométriques, informations financières personnelles, informations de santé personnelle, opinions politiques, appartenance syndicale, croyances religieuses ou philosophiques). Les données personnelles non sensibles, telles qu'un nom ou une adresse e-mail, peuvent être utilisées dans une requête pour un usage général, comme la réécriture d'un e-mail.

-   **Données hautement sensibles** (données pouvant être utilisées intentionnellement ou non pour nuire à des individus, communautés, à MSF ou à son personnel --- la sensibilité des données doit être déterminée en analysant le contexte, par exemple : localisation de projets sensibles ou de groupes à risque, incidents de sécurité, et autres détails opérationnels).

**Si vous prévoyez d'utiliser des données personnelles dans l'Assistant IA MSF dans le cadre d'un processus métier existant, contactez d'abord votre DPO.**

**Si vous souhaitez utiliser une solution IA pour vous aider à gérer ou traiter des données personnelles sensibles ou des données médicales, veuillez contacter l'équipe IA pour obtenir des conseils.**

## Violations / retours

Si vous avez des préoccupations ou souhaitez signaler un incident, veuillez contacter : [ai.team@amsterdam.msf.org](mailto:ai.team@amsterdam.msf.org)

Ces conditions peuvent être modifiées à tout moment par MSF --- nous vous en informerons en cas de changement --- votre utilisation continue de ai.msf.org vaut acceptation de toute modification.
`;

// Spanish terms
const termsTextEs: string = `# *ai.msf.org* Condiciones de Uso

El Asistente de IA de MSF es un chatbot de IA interno desarrollado para el personal de MSF. Utiliza modelos de lenguaje de gran escala dentro de Microsoft Azure Foundry, manteniendo todos los datos dentro de MSF, lo que garantiza privacidad y control.

El Asistente de IA puede ayudarte con tareas cotidianas como redactar textos, resumir documentos, traducir idiomas y redactar correos electrónicos o informes. También puede ayudar con el análisis de datos, la generación de ideas y encontrar respuestas rápidas a preguntas, lo que lo convierte en una herramienta útil para las actividades laborales diarias.

Al usar ai.msf.org, aceptas los siguientes términos y condiciones:

## Uso responsable:

Aceptas usar ai.msf.org de manera responsable. Te comprometes a:

-   Usarlo de acuerdo con las políticas de TIC, IA y otras políticas aplicables de tu entidad de MSF.

-   Verificar siempre que los resultados sean precisos, inclusivos y sin sesgos. Ai.msf.org utiliza tecnología experimental -- no garantiza que los resultados sean precisos. Además, la tecnología no ha sido entrenada con datos representativos de los pacientes y comunidades de MSF. Los resultados de IA pueden perpetuar sesgos, discriminación y estereotipos. Eres responsable de verificar los resultados producidos.

-   Verificar que los resultados no infrinjan los derechos de propiedad intelectual de terceros -- especialmente para cualquier uso público. Como otros sistemas de IA generativa, la tecnología detrás de ai.msf.org ha sido entrenada con propiedad intelectual de terceros sin permisos y licencias claras.

-   Ser transparente sobre tu uso de IA. Informa a las personas si algo que usas ha sido producido por IA, y marca los resultados como generados por IA.

**NO utilizarás ai.msf.org para ninguno de los siguientes propósitos:**

-   **Atención médica** *(para proporcionar atención médica o responder preguntas relacionadas con la salud)*

-   **Vigilancia o monitoreo de pacientes o comunidades de MSF o cualquier otro individuo(s)**

-   **Decisiones relacionadas con el empleo** *(para asistir o reemplazar decisiones relacionadas con el empleo)*

-   **Toma de decisiones automatizada** *(para tomar decisiones que podrían ser perjudiciales para un individuo o comunidad)*

-   **Creación de contenido mediático para comunicaciones externas sobre asuntos de interés público**

-   **Actividades ilegales o dañinas**

## Privacidad:

Usar ai.msf.org es un entorno más seguro y protegido que usar otras herramientas de IA gratuitas externas, que ofrecen muy pocas garantías de privacidad. Sin embargo, ten en cuenta que aún existen límites y advertencias -- consulta la política de uso para más detalles.

Como otros productos de Microsoft, tu información de inicio de sesión será procesada por MSF según lo descrito en la política de privacidad de tu entidad de MSF.

**NO ingresarás ni cargarás en ai.msf.org la siguiente información:**

-   **Datos personales sensibles** (esto incluye: origen racial o étnico, orientación sexual, datos genéticos o biométricos, información financiera personal, información de salud personal, opiniones políticas, afiliación sindical, o creencias religiosas o filosóficas). Los datos personales no sensibles, como un nombre o dirección de correo electrónico, pueden usarse en una consulta para uso general, como reescribir un correo electrónico.

-   **Datos altamente sensibles** (datos que pueden usarse intencional o involuntariamente para dañar a individuos, comunidades, MSF o su personal -- determinar la sensibilidad de los datos requiere incorporar análisis de contexto, por ejemplo: ubicaciones de proyectos sensibles o grupos en riesgo, incidentes de seguridad y otros detalles operativos)

**Si planeas usar datos personales en el Asistente de IA de MSF como parte de un proceso empresarial existente, contacta primero a tu DPO.**

**Si deseas usar una solución de IA para ayudar a gestionar o procesar datos personales sensibles o datos médicos, contacta al Equipo de IA para obtener asesoramiento.**

## Incumplimientos / comentarios

Si tienes alguna inquietud o deseas notificar un incidente, contacta a: [ai.team@amsterdam.msf.org](mailto:ai.team@amsterdam.msf.org)

Estos términos pueden ser modificados en cualquier momento por MSF -- te notificaremos si los cambiamos -- tu uso continuado de ai.msf.org constituye la aceptación de cualquier cambio.`;

const calculateHash = (content: string): string => {
  return crypto.createHash('sha256').update(content).digest('hex');
};

interface LocalizedContent {
  [locale: string]: {
    content: string;
    hash: string;
  };
}

interface TermsItem {
  localized: LocalizedContent;
  version: string;
  required: boolean;
}

interface TermsData {
  platformTerms: TermsItem;
}

const termsData: TermsData = {
  platformTerms: {
    localized: {
      en: {
        content: termsTextEn,
        hash: calculateHash(termsTextEn),
      },
      fr: {
        content: termsTextFr,
        hash: calculateHash(termsTextFr),
      },
      es: {
        content: termsTextEs,
        hash: calculateHash(termsTextEs),
      },
    },
    version: '2.0.1',
    required: true,
  },
};

export async function GET() {
  try {
    return NextResponse.json(termsData);
  } catch (error) {
    console.error('Error fetching terms:', error);
    return NextResponse.json(
      { error: 'Failed to fetch terms' },
      { status: 500 },
    );
  }
}
