import { exec } from 'child_process';
import { promisify } from 'util';
import {lookup} from "mime-types";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);

async function retryRemoveFile(filePath: string, maxRetries = 3): Promise<void> {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.promises.unlink(filePath);
      console.log(`Successfully removed file: ${filePath}`);
      return;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log(`File not found, considered as removed: ${filePath}`);
        return;
      }
      if (attempt === maxRetries - 1) {
        console.warn(`Failed to remove file after ${maxRetries} attempts: ${filePath}`);
        return;
      }
      console.warn(`Attempt ${attempt + 1} to remove file failed. Retrying...`);
      await delay(Math.pow(2, attempt) * 1000); // Exponential backoff: 1s, 2s, 4s
    }
  }
}

/**
 * Converts a file using Pandoc.
 *
 * @param {string} inputPath - The path of the input file.
 * @param {string} outputFormat - The desired output format.
 * @returns {Promise<string>} - A promise that resolves to the converted file content.
 * @throws {Error} - If there was an error converting the file.
 */
export async function convertWithPandoc(inputPath: string, outputFormat: string): Promise<string> {
  const outputPath = `${inputPath}.${outputFormat}`;
  const command = `pandoc "${inputPath}" -o "${outputPath}"`;

  try {
    await execAsync(command);
    const { stdout } = await execAsync(`cat "${outputPath}"`);
    return stdout;
  } catch (error) {
    console.error(`Error converting file with Pandoc: ${error}`);
    throw error;
  } finally {
    // Clean up temporary files
    retryRemoveFile(inputPath).catch(error => {
      console.error(`Failed to remove temporary file ${inputPath}:`, error);
    });
    retryRemoveFile(outputPath).catch(error => {
      console.error(`Failed to remove temporary file ${outputPath}:`, error);
    });

  }
}

async function pdfToText(inputPath: string): Promise<string> {
  const { stdout } = await execAsync(`pdftotext "${inputPath}" -`);
  return stdout;
}

async function xlsxToText(inputPath: string): Promise<string> {
  const tempDir = await fs.promises.mkdtemp('/tmp/xlsx-');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPattern = path.join(tempDir, `${baseName}_.csv`);

  try {
    // Convert XLSX to multiple CSV files (one per sheet)
    await execAsync(`ssconvert --export-file-per-sheet "${inputPath}" "${outputPattern}"`);

    // Read all generated CSV files
    const files = await fs.promises.readdir(tempDir);
    let result = '';

    const filePattern: string | undefined = outputPattern.split('/').pop()

    for (const file of files) {
      if (filePattern && file.indexOf(filePattern) > -1) {
        const sheetName = file.replace(`${baseName}_`, '').replace('.csv', '');
        const content = await fs.promises.readFile(path.join(tempDir, file), 'utf8');

        result += `\n\n--- START OF SHEET: ${sheetName} ---\n\n`;
        result += content;
        result += `\n\n--- END OF SHEET: ${sheetName} ---\n\n`;
      }
    }

    return result;
  } finally {
    // Clean up temporary directory and files
    const files = await fs.promises.readdir(tempDir);
    for (const file of files) {
      await retryRemoveFile(path.join(tempDir, file));
    }
    await fs.promises.rmdir(tempDir);
  }
}

async function pptToText(inputPath: string): Promise<string> {
  // TODO: Possibly find a way to do this without converting to PDF first
  const outputDir = await fs.promises.mkdtemp('/tmp/ppt-');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);

  try {
    const { stdout, stderr } = await execAsync(`libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${inputPath}"`);
    console.log('LibreOffice stdout:', stdout);
    if (stderr) {
      console.warn('LibreOffice stderr:', stderr);
    }

    // Check if the PDF file exists
    const files = await fs.promises.readdir(outputDir);
    console.log('Files in output directory:', files);

    if (!files.includes(`${baseName}.pdf`)) {
      throw new Error(`PDF file not found in ${outputDir}`);
    }

    // Extract text from the PDF
    const text = await pdfToText(pdfPath);
    return text;
  } catch (error) {
    console.error(`Error converting PPT/PPTX to PDF and extracting text: ${error}`);
    throw error;
  } finally {
    // Clean up temporary files
    retryRemoveFile(pdfPath).catch(error => {
      console.error(`Failed to remove temporary file ${pdfPath}:`, error);
    });
  }
}





export async function loadDocument(file: File): Promise<string> {
  let text, content, loader;
  const mimeType = lookup(file.name) || 'application/octet-stream';
  const tempFilePath = `/tmp/${file.name}`;

  // Write the file to a temporary location with secure permissions (0o600 = read/write for owner only)
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.promises.writeFile(tempFilePath, new Uint8Array(buffer), { mode: 0o600 });

  switch (true) {
    case mimeType.startsWith('application/pdf'):
      text = await pdfToText(tempFilePath);
      break;
    case mimeType.startsWith('application/vnd.openxmlformats-officedocument.wordprocessingml.document'):
      text = await convertWithPandoc(tempFilePath, 'markdown');
      break;
    case mimeType.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') || file.name.endsWith('.xlsx'):
      text = await xlsxToText(tempFilePath)
      break
    case mimeType.startsWith('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    || mimeType.startsWith('application/vnd.ms-powerpoint'):
      text = await pptToText(tempFilePath);
      break
    case mimeType.startsWith('application/epub+zip'):
      text = await convertWithPandoc(tempFilePath, 'markdown');
      break;
    case mimeType.startsWith('text/') || mimeType.startsWith('application/csv') || file.name.endsWith('.py') || file.name.endsWith('.sql')
    || mimeType.startsWith('application/json') || mimeType.startsWith('application/xhtml+xml') || file.name.endsWith('.tex'):
    default:
      try {
        text = await file.text()
        if (!text) {
          // If file.text() fails or returns empty, read from the temp file
          text = await fs.promises.readFile(tempFilePath, 'utf8');
        }
      } catch (error) {
        console.error(`Could not parse text from ${file.name}`);
        throw error;
      }
  }
  return text;
}
