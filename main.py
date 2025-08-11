import os
import json
import logging
import numpy as np
import faiss
from flask import Flask, render_template, request, jsonify
import google.generativeai as genai
from dotenv import load_dotenv

# --- Basic Configuration ---
load_dotenv()
app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- AI & Model Configuration ---
TEXT_EMBEDDING_MODEL = "text-embedding-004"
GENERATIVE_MODEL_NAME = "gemini-2.0-flash"

# --- AI Prompts ---
CV_ANALYSIS_PROMPT = """
You are an expert HR recruitment assistant. Analyze the following CV text and extract the information into a valid JSON object.

CV Text:
---
{cv_text}
---

Extract the following fields:
- name: The full name of the candidate.
- totalExperienceYears: The total years of professional experience, as a number. If not found, set to 0.
- companies: A single string listing the most recent 2-3 companies.
- education: A single string summarizing the highest level of education (e.g., "M.Sc. in Computer Science").
- discipline: The primary professional field (e.g., "Software Engineering", "Data Science", "Project Management").
- industry: The primary industry the candidate has worked in (e.g., "Technology", "Finance", "Healthcare").
- summary: A 2-3 sentence professional summary of the candidate.
- skills: A JSON array of the top 10-15 most relevant technical and soft skills.

Respond ONLY with the JSON object. Do not include any other text or markdown formatting.
"""

COMPARISON_PROMPT = """
You are an expert HR interviewer. Compare the following Job Description with the Candidate's Profile.

Job Description:
---
{jd_text}
---

Candidate Profile:
- Name: {name}
- Experience: {experience} years
- Summary: {summary}
- Skills: {skills}
---

Based on this comparison, provide a JSON object with:
1. "score": An integer score from 0 to 100 representing how well the candidate matches the job description.
2. "justification": A concise, one-sentence justification explaining why they are a good match and referencing key skills or experience.

Respond ONLY with the JSON object.
"""

# --- AI Initialization ---
try:
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY environment variable not set.")
    genai.configure(api_key=api_key)
    generative_model = genai.GenerativeModel(GENERATIVE_MODEL_NAME)
except (ValueError, Exception) as e:
    logging.critical(f"Fatal Error during AI Initialization: {e}")
    exit()

# --- Helper Functions for AI Logic ---

def get_ai_cv_analysis(cv_text: str) -> dict:
    """Uses a generative model to parse CV text into a structured dictionary."""
    prompt = CV_ANALYSIS_PROMPT.format(cv_text=cv_text)
    response = generative_model.generate_content(prompt)
    json_response_text = response.text.strip().replace("```json", "").replace("```", "")
    return json.loads(json_response_text)


def get_ai_comparison(jd_text: str, candidate: dict) -> dict:
    """Uses a generative model to score and justify a candidate match."""
    prompt = COMPARISON_PROMPT.format(
        jd_text=jd_text,
        name=candidate.get('name', 'N/A'),
        experience=candidate.get('totalExperienceYears', 0),
        summary=candidate.get('summary', 'N/A'),
        skills=', '.join(candidate.get('skills', []))
    )
    response = generative_model.generate_content(prompt)
    json_text = response.text.strip().replace("```json", "").replace("```", "")
    return json.loads(json_text)

# --- Flask Routes ---

@app.route('/')
def index():
    """Renders the main HTML page."""
    return render_template('index.html')


@app.route('/api/analyze-cv', methods=['POST'])
def analyze_cv_endpoint():
    """API endpoint to analyze a single CV."""
    data = request.get_json()
    cv_text = data.get('cvText')

    if not cv_text or len(cv_text) < 50:
        return jsonify({"error": "CV text is too short or missing."}), 400

    try:
        cv_data = get_ai_cv_analysis(cv_text)
        logging.info(f"Successfully analyzed CV for: {cv_data.get('name', 'Unknown')}")
        return jsonify(cv_data)
    except json.JSONDecodeError:
        logging.error("AI failed to return valid JSON for CV analysis.")
        return jsonify({"error": "AI model returned an invalid format. Please try again."}), 500
    except Exception as e:
        logging.error(f"Error in /api/analyze-cv: {e}")
        return jsonify({"error": "An unexpected error occurred during CV analysis."}), 500


@app.route('/api/compare', methods=['POST'])
def compare_candidates_endpoint():
    """API endpoint to compare candidates against a job description."""
    data = request.get_json()
    jd_text = data.get('jdText')
    candidates = data.get('candidates', [])

    if not jd_text or not candidates:
        return jsonify({"error": "Job description or candidate data is missing."}), 400

    try:
        # 1. Create a "document" for each candidate for embedding
        candidate_docs = [
            f"Summary: {c.get('summary', '')}\nSkills: {', '.join(c.get('skills', []))}"
            for c in candidates
        ]
        
        # 2. Generate embeddings for the JD and all candidates
        jd_embedding = genai.embed_content(model=TEXT_EMBEDDING_MODEL, content=jd_text)['embedding']
        candidate_embeddings = genai.embed_content(model=TEXT_EMBEDDING_MODEL, content=candidate_docs)['embedding']

        # 3. Use FAISS for efficient similarity search
        candidate_vectors = np.array(candidate_embeddings, dtype='float32')
        jd_vector = np.array(jd_embedding, dtype='float32').reshape(1, -1)
        
        index = faiss.IndexFlatL2(candidate_vectors.shape[1])
        index.add(candidate_vectors)
        
        # Search for top 3 most similar candidates
        distances, indices = index.search(jd_vector, k=min(3, len(candidates)))
        
        # 4. Generate AI-powered justification for the top matches
        results = []
        for i in range(len(indices[0])):
            candidate_index = indices[0][i]
            top_candidate = candidates[candidate_index]

            try:
                ai_justification = get_ai_comparison(jd_text, top_candidate)
                results.append({
                    "name": top_candidate.get('name'),
                    "score": ai_justification.get('score', 0),
                    "justification": ai_justification.get('justification', 'No justification provided.')
                })
            except Exception as e:
                logging.warning(f"Could not generate AI justification for {top_candidate.get('name', 'a candidate')}: {e}")
                # Fallback to a score based on vector distance if justification fails
                score = max(0, 100 - int(distances[0][i] * 50))
                results.append({
                    "name": top_candidate.get('name'),
                    "score": score,
                    "justification": "Strong keyword and conceptual match based on vector similarity."
                })

        results.sort(key=lambda x: x['score'], reverse=True)
        logging.info(f"Successfully compared {len(candidates)} candidates.")
        return jsonify(results)

    except Exception as e:
        logging.error(f"Error in /api/compare: {e}")
        return jsonify({"error": f"An unexpected error occurred during comparison."}), 500

# --- Error Handling ---
@app.errorhandler(500)
def internal_server_error(e):
    logging.error(f"Server Error: {e}")
    return jsonify(error="An internal server error occurred."), 500

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5135)