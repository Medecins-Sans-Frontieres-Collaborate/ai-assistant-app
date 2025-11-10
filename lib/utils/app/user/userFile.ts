import fs from 'fs/promises';
import path from 'path';

interface ValidFileTypes {
  txt: boolean;
  pdf: boolean;
  docx: boolean;
  'text/plain': boolean;
  // Add more supported file types as needed
}

type ValidFileExtensions = 'txt' | 'pdf' | 'docx';

type ValidFileLocations = 'local' | 'remote';

export class UserFileHandler {
  private readonly fileData: Blob | string;
  private readonly fileType: ValidFileExtensions | undefined;
  private readonly fileLocation: ValidFileLocations;
  private readonly validFileTypes: ValidFileTypes;

  constructor(fileData: Blob | string, validFileTypes: ValidFileTypes) {
    this.fileData = fileData;
    this.validFileTypes = validFileTypes;
    this.fileLocation = this.determineFileLocationType(fileData);
    this.fileType = this.determineFileType(fileData) as ValidFileExtensions;

    if (this.fileType && !this.validFileTypes[this.fileType]) {
      throw new Error(`Unsupported file type: ${this.fileType}`);
    }
  }

  private determineFileLocationType(
    fileData: Blob | string,
  ): ValidFileLocations {
    if (fileData instanceof Blob) {
      return 'local';
    } else if (
      fileData.startsWith('http://') ||
      fileData.startsWith('https://')
    ) {
      return 'remote';
    } else {
      return 'local';
    }
  }

  private determineFileType(fileData: Blob | string): string | undefined {
    if (fileData instanceof Blob) {
      return fileData.type.split('/')[1];
    } else {
      return fileData.split('.').pop();
    }
  }

  private async extractTextFromTxtFile(): Promise<string> {
    try {
      const filePath = path.join(process.cwd(), this.fileData as string);
      return await fs.readFile(filePath, 'utf-8');
    } catch (error: any) {
      console.error('Error reading text file:', error);
      throw new Error('Failed to read text file');
    }
  }

  public async extractText(): Promise<string> {
    if (this.fileType && !this.validFileTypes[this.fileType]) {
      throw new Error(
        `Text extraction not supported for file type: ${this.fileType}`,
      );
    }

    if (this.fileLocation === 'local') {
      if (this.fileData instanceof Blob) {
        return await this.fileData.text();
      } else {
        let txt = '';
        switch (this.fileType) {
          case 'txt':
            return await this.extractTextFromTxtFile();
          case 'pdf':
            // Use appropriate library to extract text from PDF
            return txt;
          case 'docx':
            // Use appropriate library to extract text from DOCX
            return txt;
          // Add more cases for other supported file types
        }
      }
    } else {
      const response = await fetch(this.fileData as string);
      const blob = await response.blob();
      let txt = '';

      switch (this.fileType) {
        case 'txt':
          return await blob.text();
        case 'pdf':
          // Use appropriate library to extract text from PDF
          return txt;
        case 'docx':
          // Use appropriate library to extract text from DOCX
          return txt;
        // Add more cases for other supported file types
      }
    }
    return '';
  }
}
