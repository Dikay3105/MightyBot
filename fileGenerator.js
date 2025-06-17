const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph } = require('docx');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const outputDir = path.join(__dirname, 'files');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

async function generateFileFromResponse(prompt, content) {
    const lower = prompt.toLowerCase();

    let filename = '';
    let filePath = '';

    // ✅ PDF: đảm bảo ghi xong trước khi trả về
    if (lower.includes('pdf')) {
        filename = `response.pdf`;
        filePath = path.join(outputDir, filename);

        await new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const stream = fs.createWriteStream(filePath);

            doc.pipe(stream);
            doc.font('Times-Roman').fontSize(12).text(content, {
                align: 'left',
                lineGap: 4,
            });
            doc.end();

            stream.on('finish', resolve);
            stream.on('error', reject);
        });

        return filePath;
    }

    // Word (.docx)
    if (lower.includes('word') || lower.includes('docx')) {
        filename = `response.docx`;
        filePath = path.join(outputDir, filename);
        const doc = new Document({
            sections: [{
                properties: {},
                children: [new Paragraph(content)],
            }],
        });
        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(filePath, buffer);
        return filePath;
    }

    // Excel (.xlsx)
    if (lower.includes('excel') || lower.includes('xlsx')) {
        filename = `response.xlsx`;
        filePath = path.join(outputDir, filename);
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Sheet 1');
        content.split('\n').forEach((line) => {
            sheet.addRow([line]);
        });
        await workbook.xlsx.writeFile(filePath);
        return filePath;
    }

    // Mặc định .txt
    if (lower.includes('tệp') || lower.includes('file')) {
        filename = `response.txt`;
        filePath = path.join(outputDir, filename);
        fs.writeFileSync(filePath, content);
        return filePath;
    }

    return null;
}

module.exports = { generateFileFromResponse };
