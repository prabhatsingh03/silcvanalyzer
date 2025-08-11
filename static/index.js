window.onload = () => {
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.14.305/pdf.worker.min.js`;
    } else {
        console.error("Fatal Error: pdf.js library not found.");
        document.body.innerHTML = `<div class="text-red-600 font-bold p-4 text-center">Error: A critical library (pdf.js) failed to load. Please check your internet connection and refresh the page.</div>`;
        return;
    }

    if (typeof mammoth === 'undefined') {
        console.error("Fatal Error: mammoth.js library not found.");
        return;
    }

    // --- DOM Element References ---
    const folderInput = document.getElementById('folderInput');
    const uploadSection = document.getElementById('upload-section');
    const processingSection = document.getElementById('processing-section');
    const welcomeScreen = document.getElementById('welcome-screen');
    const resultsDashboard = document.getElementById('results-dashboard');
    const statusTableBody = document.getElementById('status-table-body');
    const downloadBtn = document.getElementById('downloadBtn');
    const downloadHint = document.getElementById('download-hint');
    const jdUploadInput = document.getElementById('jd-upload-input');
    const jdFileName = document.getElementById('jd-file-name');
    const compareBtn = document.getElementById('compareBtn');
    const comparisonResultsContainer = document.getElementById('comparison-results-container');
    const candidateGrid = document.getElementById('candidate-grid');
    const modalContainer = document.getElementById('modal-container');
    const modalName = document.getElementById('modal-name');
    const modalBody = document.getElementById('modal-body');
    const modalCloseBtn = document.getElementById('modal-close-btn');

    let processedCVs = [];
    let jdText = '';

    async function handleFolderSelect(e) {
        try {
            const files = e.target.files;
            if (!files || !files.length) return;

            resetState();
            uploadSection.classList.add('hidden');
            processingSection.classList.remove('hidden');
            welcomeScreen.classList.add('hidden');
            
            const validFiles = Array.from(files).filter(file =>
                file.name.toLowerCase().endsWith('.pdf') || file.name.toLowerCase().endsWith('.docx')
            );

            if (validFiles.length === 0) {
                statusTableBody.innerHTML = `<tr><td class="p-4 text-center text-red-500">No valid .pdf or .docx files found.</td></tr>`;
                return;
            }

            validFiles.forEach(file => addStatusRow(file.name, "Queued", 'pending'));

            for (const file of validFiles) {
                await processFile(file);
            }
        } catch (error) {
            console.error("Critical error in handleFolderSelect:", error);
            statusTableBody.innerHTML = `<tr><td class="p-4 text-center text-red-600">A critical error occurred. Please refresh.</td></tr>`;
        }
    }
    
    async function handleJDFileSelect(e) {
        const file = e.target.files[0];
        if (!file) {
            jdText = '';
            jdFileName.textContent = '';
            return;
        }

        jdFileName.textContent = `Selected: ${file.name}`;

        try {
            jdText = await extractTextFromFile(file);
            if (!jdText) {
                alert("Could not extract text from the Job Description file.");
                jdFileName.textContent = `Error reading file. Please try another.`;
            }
        } catch (error) {
            console.error("Error processing JD file:", error);
            alert(`Error processing JD file: ${error.message}`);
            jdFileName.textContent = `Error: ${error.message}`;
            jdText = '';
        }
    }

    async function processFile(file) {
        const fileName = file.name;
        try {
            updateStatus(fileName, "Extracting text...", 'processing');
            const text = await extractTextFromFile(file);

            if (!text || text.trim().length < 50) {
                updateStatus(fileName, "Error: Empty file.", 'error');
                return;
            }

            updateStatus(fileName, "Analyzing with AI...", 'analyzing');
            const aiResult = await analyzeCVWithAI(text);

            if (aiResult) {
                const resultWithFilename = { ...aiResult, filename: fileName };
                processedCVs.push(resultWithFilename);
                renderCandidateCards();
                updateStatus(fileName, "Complete", 'success');

                if (downloadBtn.disabled) {
                    downloadBtn.disabled = false;
                    downloadHint.classList.add('hidden');
                    resultsDashboard.classList.remove('hidden');
                }
            } else {
                throw new Error("AI analysis returned empty result.");
            }

        } catch (error) {
            console.error(`Error processing ${fileName}:`, error);
            let errorMessage = error.message || 'Unknown error.';
            updateStatus(fileName, `Error: ${errorMessage}`, 'error');
        }
    }

    function extractTextFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const fileType = file.name.toLowerCase().split('.').pop();
            reader.onload = async (event) => {
                try {
                    const fileBuffer = event.target?.result;
                    if (!fileBuffer || !(fileBuffer instanceof ArrayBuffer)) {
                        return reject(new Error("Could not read file buffer."));
                    }

                    if (fileType === 'pdf') {
                        if (!pdfjsLib) return reject(new Error("pdf.js library is not available."));
                        const typedarray = new Uint8Array(fileBuffer);
                        const pdf = await pdfjsLib.getDocument(typedarray).promise;
                        let fullText = '';
                        for (let i = 1; i <= pdf.numPages; i++) {
                            const page = await pdf.getPage(i);
                            const textContent = await page.getTextContent();
                            fullText += textContent.items.map((item) => item.str).join(' ') + '\n';
                        }
                        resolve(fullText);
                    } else if (fileType === 'docx') {
                        if (!mammoth) return reject(new Error("mammoth.js library is not available."));
                        const result = await mammoth.extractRawText({ arrayBuffer: fileBuffer });
                        resolve(result.value);
                    } else {
                        reject(new Error("Unsupported file type"));
                    }
                } catch (error) {
                     if (error.message && (error.message.includes('Invalid PDF structure') || error.name === 'InvalidPDFException')) {
                        reject(new Error('Invalid PDF structure. File may be corrupt or password-protected.'));
                    } else if (error.message && error.message.includes('central directory')) {
                        reject(new Error('Invalid DOCX file. The file may be corrupt.'));
                    } else {
                        reject(error);
                    }
                }
            };
            reader.onerror = (error) => reject(error);
            reader.readAsArrayBuffer(file);
        });
    }

    async function analyzeCVWithAI(cvText) {
        const response = await fetch('/api/analyze-cv', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ cvText: cvText }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server error: ${response.status} ${errorText}`);
        }
        
        return await response.json();
    }
    
    async function handleComparison() {
        if (!jdText) {
            alert("Please upload a job description first.");
            return;
        }
        if (processedCVs.length === 0) {
            alert("No CVs have been processed yet.");
            return;
        }

        compareBtn.disabled = true;
        comparisonResultsContainer.innerHTML = `<div class="flex items-center justify-center p-4 text-slate-600"><div class="spinner mr-3"></div><span>Comparing candidates with AI... This may take a moment.</span></div>`;

        try {
            const candidateProfilesText = processedCVs.map(cv => (
                `Candidate: ${cv.name}\n` +
                `Experience: ${cv.totalExperienceYears} years\n` +
                `Skills: ${cv.skills.join(', ')}\n` +
                `Summary: ${cv.summary}`
            )).join('\n---\n');

            const response = await fetch('/api/compare', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    jdText: jdText,
                    candidates: processedCVs
                }),
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Server error: ${response.status} ${errorText}`);
            }

            const results = await response.json();
            renderComparisonResults(results);

        } catch (error) {
            console.error("Error during comparison:", error);
            comparisonResultsContainer.innerHTML = `<div class="text-center p-4 text-red-600">An error occurred during comparison: ${error.message}</div>`;
        } finally {
            compareBtn.disabled = false;
        }
    }
    
    function renderComparisonResults(results) {
        if (results.length === 0) {
            comparisonResultsContainer.innerHTML = `<div class="text-center p-4 text-slate-600">No matches found for this job description.</div>`;
            return;
        }
        
        let html = '<h3 class="text-lg font-bold text-slate-800 mb-4">Comparison Results</h3><div class="space-y-4">';
        
        results.forEach(result => {
            const candidate = processedCVs.find(cv => cv.name === result.name);
            const ringColor = result.score >= 80 ? '#22c55e' : result.score >= 50 ? '#3b82f6' : '#94a3b8';

            html += `
                <div class="comparison-card bg-slate-50 p-4 rounded-lg border border-slate-200 flex items-start space-x-4">
                    <div class="score-ring-container flex-shrink-0">
                        ${createScoreRing(result.score, ringColor)}
                    </div>
                    <div class="flex-grow">
                        <h4 class="font-bold text-slate-800">${result.name}</h4>
                        <p class="text-sm text-slate-600 mt-1">${result.justification}</p>
                        ${candidate && candidate.skills.length > 0 ? `
                        <div class="mt-2 flex flex-wrap gap-2">
                            ${candidate.skills.slice(0, 5).map(skill => `<span class="skill-tag">${skill}</span>`).join('')}
                        </div>` : ''}
                    </div>
                </div>
            `;
        });

        html += '</div>';
        comparisonResultsContainer.innerHTML = html;
    }

    function createScoreRing(score, color) {
        const radius = 24;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (score / 100) * circumference;

        return `
            <svg class="score-ring" viewBox="0 0 60 60">
                <circle class="text-slate-200" stroke-width="6" stroke="currentColor" fill="transparent" r="${radius}" cx="30" cy="30" />
                <circle class="score-ring-circle"
                        stroke="${color}"
                        stroke-width="6"
                        stroke-linecap="round"
                        fill="transparent"
                        r="${radius}"
                        cx="30"
                        cy="30"
                        style="stroke-dasharray:${circumference}; stroke-dashoffset:${offset}"
                />
                <text x="50%" y="50%" text-anchor="middle" dy=".3em" class="font-bold text-sm" fill="${color}">${score}</text>
            </svg>
        `;
    }

    function downloadExcel() {
        if (processedCVs.length === 0) return;
        
        const dataForSheet = processedCVs.map(cv => ({
            "Name": cv.name || 'N/A',
            "Experience (Yrs)": cv.totalExperienceYears ?? 0,
            "Companies": cv.companies || 'N/A',
            "Education": cv.education || 'N/A',
            "Discipline": cv.discipline || 'N/A',
            "Industry": cv.industry || 'N/A',
            "Skills": cv.skills.join(', ') || 'N/A',
            "Summary": cv.summary || 'N/A',
            "Source File": cv.filename || 'N/A'
        }));

        const worksheet = XLSX.utils.json_to_sheet(dataForSheet);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "CV Analysis Results");

        if (dataForSheet.length > 0) {
            const headers = Object.keys(dataForSheet[0]);
            const colWidths = headers.map(header => {
                const lengths = dataForSheet.map(row => {
                    const value = row[header];
                    return value != null ? String(value).length : 0;
                });
                lengths.push(header.length);
                const maxWidth = Math.max(...lengths);
                return { wch: maxWidth + 2 };
            });
            worksheet["!cols"] = colWidths;
        }

        XLSX.writeFile(workbook, "SIL_CV_Analysis_Report.xlsx");
    }
    
    function resetState() {
        processedCVs = [];
        statusTableBody.innerHTML = '';
        candidateGrid.innerHTML = '';
        welcomeScreen.classList.remove('hidden');
        resultsDashboard.classList.add('hidden');
        downloadBtn.disabled = true;
        downloadHint.classList.remove('hidden');
        uploadSection.classList.remove('hidden');
        processingSection.classList.add('hidden');
        jdUploadInput.value = '';
        jdFileName.textContent = '';
        jdText = '';
        comparisonResultsContainer.innerHTML = '';
    }
    
    function addStatusRow(fileName, statusText, type = 'pending') {
         const row = document.createElement('tr');
         row.id = `status-${fileName.replace(/[^a-zA-Z0-9]/g, '')}`;
         row.innerHTML = `<td class="p-2 truncate" title="${fileName}">${fileName.substring(0,25)}${fileName.length > 25 ? '...' : ''}</td><td class="p-2 status-cell w-36"></td>`;
         statusTableBody.appendChild(row);
         updateStatus(fileName, statusText, type);
    }

    function updateStatus(fileName, statusText, type) {
        const rowId = `status-${fileName.replace(/[^a-zA-Z0-9]/g, '')}`;
        const row = document.getElementById(rowId);
        if (!row) return;

        const statusCell = row.querySelector('.status-cell');
        if (!statusCell) return;
        
        let statusIcon = '';
        let textColor = 'text-slate-600';

        switch(type) {
            case 'processing': statusIcon = `<div class="spinner mr-2"></div>`; textColor = 'text-blue-600'; break;
            case 'analyzing': statusIcon = `<div class="pulse-dot mr-2"></div>`; textColor = 'text-indigo-600'; break;
            case 'error': statusIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-2 text-red-500" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" /></svg>`; textColor = 'text-red-600'; break;
            case 'success': statusIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1.5 text-green-500" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg>`; textColor = 'text-green-600'; break;
            case 'pending': default: statusIcon = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;
        }
        
        statusCell.innerHTML = `<div class="flex items-center text-xs font-medium ${textColor}">${statusIcon} <span>${statusText}</span></div>`;
    }
    
    function renderCandidateCards() {
        candidateGrid.innerHTML = ''; 
        processedCVs.forEach(cv => {
            const card = document.createElement('div');
            card.className = 'candidate-card bg-white p-5 rounded-xl shadow-sm border border-slate-200 flex flex-col';
            card.innerHTML = `
                <div class="flex-grow">
                    <h3 class="font-bold text-lg text-slate-800">${cv.name || 'N/A'}</h3>
                    <p class="text-sm text-slate-500 font-medium">${cv.discipline} &bull; ${cv.totalExperienceYears ?? '0'} Yrs Exp</p>
                    <div class="mt-4 flex flex-wrap gap-2">
                        ${cv.skills && cv.skills.length > 0 ? cv.skills.slice(0, 5).map(skill => `<span class="skill-tag">${skill}</span>`).join('') : '<span class="text-sm text-slate-400">No skills extracted.</span>'}
                    </div>
                </div>
                <div class="mt-5 text-right flex-shrink-0">
                    <button data-filename="${cv.filename}" class="view-details-btn text-sm font-semibold text-indigo-600 hover:text-indigo-800 transition-colors">View Details &rarr;</button>
                </div>
            `;
            candidateGrid.appendChild(card);
        });

        document.querySelectorAll('.view-details-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filename = e.currentTarget.dataset.filename;
                showCandidateModal(filename);
            });
        });
    }

    function showCandidateModal(filename) {
        if (!filename) return;
        const cv = processedCVs.find(c => c.filename === filename);
        if (!cv) return;

        modalName.textContent = cv.name;
        modalBody.innerHTML = `
            <div class="space-y-4">
                <div>
                    <h4 class="font-semibold text-slate-600 text-sm">Summary</h4>
                    <p class="text-slate-800">${cv.summary || 'N/A'}</p>
                </div>
                 <div>
                    <h4 class="font-semibold text-slate-600 text-sm">Key Skills</h4>
                     <div class="mt-1 flex flex-wrap gap-2">
                        ${cv.skills && cv.skills.length > 0 ? cv.skills.map(skill => `<span class="skill-tag">${skill}</span>`).join('') : '<p class="text-slate-800">N/A</p>'}
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-4 pt-2">
                    <div>
                        <h4 class="font-semibold text-slate-600 text-sm">Total Experience</h4>
                        <p class="text-slate-800">${cv.totalExperienceYears} years</p>
                    </div>
                    <div>
                        <h4 class="font-semibold text-slate-600 text-sm">Education</h4>
                        <p class="text-slate-800">${cv.education || 'N/A'}</p>
                    </div>
                    <div>
                        <h4 class="font-semibold text-slate-600 text-sm">Primary Industry</h4>
                        <p class="text-slate-800">${cv.industry || 'N/A'}</p>
                    </div>
                     <div>
                        <h4 class="font-semibold text-slate-600 text-sm">Recent Companies</h4>
                        <p class="text-slate-800">${cv.companies || 'N/A'}</p>
                    </div>
                </div>
                 <div>
                    <h4 class="font-semibold text-slate-600 text-sm">Source File</h4>
                    <p class="text-slate-800 font-mono text-xs">${cv.filename}</p>
                </div>
            </div>
        `;

        modalContainer.classList.remove('hidden');
        modalContainer.classList.add('flex');
    }

    function hideCandidateModal() {
        modalContainer.classList.add('hidden');
        modalContainer.classList.remove('flex');
    }

    // --- Event Listeners ---
    folderInput.addEventListener('change', handleFolderSelect);
    jdUploadInput.addEventListener('change', handleJDFileSelect);
    downloadBtn.addEventListener('click', downloadExcel);
    compareBtn.addEventListener('click', handleComparison);
    modalCloseBtn.addEventListener('click', hideCandidateModal);
    modalContainer.addEventListener('click', (e) => {
        if (e.target === modalContainer) hideCandidateModal();
    });
};