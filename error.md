
Problem-1
- When i upload file it process and chunck it
- but dont how on what basis rag chunck it and test it
- you can use free embedding model and k index to get better results
- there should chatbox. i can ask and test 
- example if i ask please give me login related testcase or please tell me exact requirement to implement login etc question
then it should use rag and give respective answer


Problem-2
When i upload file it process and chunck it
but when i used same in testplan as indexed document 


Give Scope : please create test plan based on product requirement document attached to it 
- Preview format doset looks good
- I am not sure whether it takes that pick correct or all chunck bases on scope and create testplan by giving indexed data to ai model and at end give end result


Problem-3 
It is giving result when i ask question to chatbox in document but formatting looks worst not readable format 

do you use give this chunk data to LLM and then produce output in readable good format ?

and if data is not present in any chunk and user asking question then you can say no data availble realted to this


Output right now:

-Based on the retrieved document chunks, these are good test case candidates:

TC-001: Validate TC-00078,VWO-3363,Verify 2FA challenge after login when TOTP enabled (warm cache),Auth,...
- Source: testcases_vwo_100.csv, chunk 4
- Evidence: TC-00078,VWO-3363,Verify 2FA challenge after login when TOTP enabled (warm cache),Auth,P3,Major,e2e|security|ui,TOTP enabled,1. Login || 2. Enter TOTP,Login succeeds,Security,kavya.iyer,VWO-25.S30,Active

TC-002: Validate TC-00145,VWO-4947,Verify fallback admin can login with password when SSO down (rtl loca...
- Source: testcases_vwo_100.csv, chunk 6
- Evidence: TC-00145,VWO-4947,Verify fallback admin can login with password when SSO down (rtl locale),SSO,P2,Trivial,api|chrome|mobile|security|smoke,SSO IdP unreachable,1. Login as fallback admin with password,Login allowed for fallback only,Security,neha.khanna,VWO-25.S22,Active

TC-003: Validate TC-00231,VWO-4936,Verify admin IP allowlist blocks logins from outside (low-bandwidth),...
- Source: testcases_vwo_100.csv, chunk 10
- Evidence: TC-00231,VWO-4936,Verify admin IP allowlist blocks logins from outside (low-bandwidth),Admin,P2,Minor,api|e2e|firefox|gdpr|security,Allowlist set,1. Login from IP not on list,Login blocked with message,Security,riya.sharma,VWO-25.S01,Active

TC-004: Validate TC-00236,VWO-5941,Verify Test Login button initiates OneLogin flow (fr-FR),SSO,P2,Criti...
- Source: testcases_vwo_100.csv, chunk 11
- Evidence: TC-00236,VWO-5941,Verify Test Login button initiates OneLogin flow (fr-FR),SSO,P2,Critical,accessibility|billing|i18n|security,SSO config saved,1. Click Test Login,"Browser redirects to IdP, returns successfully",Security,neha.khanna,VWO-25.S37,Active

TC-005: Validate TC-00383,VWO-4712,Verify successful login with valid credentials lands on dashboard (cl...
- Source: testcases_vwo_100.csv, chunk 18
- Evidence: TC-00383,VWO-4712,Verify successful login with valid credentials lands on dashboard (clean install),Auth,P2,Major,accessibility|security|smoke,Active user account,1. Open /auth/login || 2. Enter creds || 3. Submit,Redirect to /dashboard | Session cookie set,Functional,arjun.kapoor,VWO-25.S44,Active

Retrieval basis:
1. TC-00063,VWO-4030,Verify forgot-password email link resets password (hi-IN),Auth,P2,Trivial,regression|security|ui,User exists,1. Submit forgot form || 2. Open email link || 3. Set new pass,New pass works | Old pass rejected,Functional,ishaan.mehta,VWO-25.S39,Active TC-00064,VWO-3352,Verify submit rate metric in Forms summary (pt-BR),Forms,P1,Minor,dataloss|regression,Forms data ready,1. Open summary,Submit rate disp
   Source: testcases_vwo_100.csv, chunk 4, score 5
2. TC-00127,VWO-2590,Verify adding annotation to report timeline (role: Viewer),Reports,P2,Major,billing|firefox|regression|ui,Report timeline view,"1. Click on date, add note 'BFCM start'","Annotation persists, visible to team",Functional,aditya.rao,VWO-25.S24,Active TC-00128,VWO-1339,Verify page-visit goal regex '/thank-you.*' matches (role: Admin),Goals,P2,Minor,chrome|mobile|performance|regression,Campaign Draft,1. 
   Source: testcases_vwo_100.csv, chunk 6, score 5
3. TC-00211,VWO-3103,Verify combination matrix shows all permutations for MVT (cookieless),MVT,P0,Blocker,mobile|performance|regression|sanity|security,MVT Draft 3x3,1. Open Combinations tab,27 combinations listed | Disable individual combos works,Functional,riya.sharma,VWO-25.S21,Active TC-00212,VWO-1526,Verify gradual rollout slider 25% to 100% over time (third-party blocked),Personalization,P3,Minor,chrome|regression
   Source: testcases_vwo_100.csv, chunk 10, score 5
4. TC-00232,VWO-3604,Verify warning banner when SmartCode missing on test URL (high-load),AB Testing,P1,Major,chrome|edge|regression|smoke,"A/B campaign Draft, SmartCode not installed",1. Click Validate URL,Banner 'SmartCode not detected' | Launch button disabled,Negative,neha.khanna,VWO-25.S01,Active TC-00233,VWO-5183,Verify click goal CSS selector '#cta-buy' captures clicks (rtl locale),Goals,P2,Major,chrome|regressio
   Source: testcases_vwo_100.csv, chunk 11, score 5

Problem - 4
I checked test plan output its format also not much readable i know you are giving result in md format then you can add proper previwer to read it
and 


Note: global rule applicable to document chatbox, test plan, test cases
make sure for testplan format should be standard
simlarly for testcases format should be standard jira table format
and if question related specfic ask in chatbox then answer should be precise
No meta data in all cases
you can improve it more 


Problem - 5
In Testcase generater
when i give feature description
"
please create testcase for login feature with additional requirement for spectic domain user like google.com, microsoft.com we will show username field on basis of domain if domain is provided domain then disable password field and show google or micrsoft icon in sigin button when we click on that button it should open sso screen. please refer testcases document attached for existing testcases references "

Then attached testcase document 

click Generate testcase

Horrified Output 

1. It is not even related testcases to login and additional requirement 
2. I am not sure chunk retrived correct or not 
3. I am not sure when chunk data and prompt given to LLM AI model which generate result correctly or not

Output?
ID	Title	Module	Priority	Type	Steps	Expected
-	Verify Verify domain claim DNS TXT record check (role: Admin)	SSO	P1	Functional	1. Add domain | 2. Add TXT | 3. Verify	Domain marked claimed
-	Validate error handling for Verify warning banner when SmartCode missing on test URL (high-load)	AB Testing	P1	Negative	1. Click Validate URL	Banner 'SmartCode not detected' | Launch button disabled
-	Regression check for Verify confetti view filters clicks by source on '/' (Chrome)	Heatmaps	P2	Regression	1. Open Confetti | 2. Filter source=email	Each dot color-coded by source
-	Validate boundary behavior for Verify A/B test saves as Draft when launch is skipped (p1)	AB Testing	P2	Boundary	1. Fill name 'Hero CTA Draft' | 2. Add 2 variations | 3. Click 'Save as Draft'	Campaign appears under Drafts tab | Status badge = 'Draft'
-	Verify Verify Variation Editor loads target URL in iframe (en-US)	Editor	P1	Functional	1. Open editor	Iframe renders site | Toolbar visible

Problem 6
I told lot of time testplan, test case generation on based on ingestion retrival data and LLM model 

i dont want indexed document feature. remove it wherever you mentioned and replace with ingestion-retrival rag pipeline because i know company data ingested using rag pipeline all data is there

example testcase generater has index document feature reomove and remove this index document feature from everywhere main source of data is rag pipeline 


wheneven i give you  scope in testplan generater  and 
or Feature description in testcase generater

i want you to retriev first relevant data from pipeline and scope/requirement both feed to LLM and get response from LLM show as output 

Problem 7
when i give requirement in testcase generator and click generate testcase getting error 

{"error":"LLM returned invalid test case JSON."}