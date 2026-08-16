import json, re, os
import random
from icrawler.builtin import ImageDownloader
from icrawler.builtin import GoogleImageCrawler
from global_methods import run_chatgpt, run_chatgpt_with_examples

PERSONA_FROM_MSC_PROMPT = "Let's write speaker descriptions from a given set of life attributes. Example:\n\n%s\n\nNote: Add crucial details in the persona about the person such as their name, age, marital status, gender, job etc. Add additional details like names of family/friends or specific activities, likes and dislikes, experiences when appropriate.\n\nFor the following attributes, write a persona. Output a json file with the keys 'persona' and 'name'.\n\n%s\n\nStart your answer with a curly bracket.\n"


EVENT2QUERY_PROMPT = "Let's write short image search queries in order to find a suitable image for illustrating the given events. Queries should not include names of people, years and other irrelevant details. For example:\n\nInput: A picture of the modern art museum he visited with his grandchildren in Paris in 2018.\nOutput: modern art museum in Paris\n\nInput: A picture of the shared room she and her siblings lived in when she was growing up.\nOutput: cramped room with multiple beds\n\nInput: A photo of the new art supplies Jeremy bought for his upcoming art project with his mentor.\nOutput: new art supplies on a table\n\nInput: A picture of the delicious homemade vegetable smoothie she prepared using fresh produce from her well-organized garden, which she loves to maintain every morning.\n Output: produce garden at home\n\nWrite search queries for the following inputs.\n\n%s\n\nWrite answers in the form of a json list, where each entry is a query."


AGENT_CONV_PROMPT_SESS_1 = "%s\n\n%s is meeting %s for the first time. Today is %s. Assume the role of %s and write the next thing you would say to %s in the conversation. If starting the conversation, start with asking about their day or talking about something that happened in your life recently. Do not repeat information shared previously in the conversation. Make the conversation personal e.g., talk about family, friends, likes, dislikes and aspirations. Include references to time such as 'last Friday', 'next month' or 'when I was ten years old', and to specific places and locations. Write replies in less than 20 words. When appropriate, write replies where you share a photo and talk about it to make the conversation more engaging. Photos can be of things you own or like, things you need help with, or old memories. When sharing a photo, write the detailed caption of the photo between square brackets. For example,\n\n%s: When I was a child, my mother used to bake pineapple birthday cakes and I loved them.\n[shares an old photo of a pineapple birthday cake with a candle that says 1]\n\nTo end the conversation, write 'Bye!'.\n\nCONVERSATION:\n\n"

AGENT_CONV_PROMPT_SESS_1_W_EVENTS = """
Use a given PERSONALITY to write the next thing you would say in the conversation. 
- If starting the conversation, start with asking about the other person or talking about something that happened in your life recently. 
- Do not repeat information shared previously in the conversation.
- Include references to time such as 'last Friday', 'next month' or 'when I was ten years old', and to specific people. 
- Write replies in less than 20 words.
- Ask follow-up questions from previous conversations. 
- Find opportunities to write replies where you share a photo of things you own or like, things you need help with, or old memories, and talk about the photo to tell them more about yourself. Photos should be relevant to you.
- When sharing a photo, write the detailed caption of the photo between square brackets. For example, "When I was a child, my mother used to bake pineapple birthday cakes and I loved them.\n[shares an old photo of a pineapple birthday cake with a candle that says 1]"

PERSONALITY: %s

%s is meeting %s for the first time. Today is %s. The following events have happened in %s's life.
EVENTS: %s

Assume the role of %s and talk about these EVENTS in a friendly and intimate conversation with %s. %s
"""


AGENT_CONV_PROMPT = "%s\n\n%s last talked to %s at %s. %s\n\nToday is %s. Assume the role of %s and write the next thing you would say to %s in the conversation. If starting the conversation, start with asking about their day, or a follow-up question from a previous conversation or something from your life they would be interested in. Do not repeat information already shared in prevoius conversations. Make the conversation personal e.g., talk about family, friends, likes, dislikes and aspirations. Include references to time such as 'last Friday', 'next month' or 'when I was ten years old', and to specific places and locations. Write replies in less than 20 words. When appropriate, write replies where you share a photo and talk about it to make the conversation more engaging. Photos can be of things you own or like, things you need help with, or old memories. When sharing a photo, write the detailed caption of the photo between square brackets. For example,\n\n%s: When I was a child, my mother used to bake pineapple birthday cakes and I loved them.\n[shares an old photo of a pineapple birthday cake with a candle that says 1]\n\n To end the conversation, write 'Bye!'.\n\nCONVERSATION:\n\n"


AGENT_CONV_PROMPT_W_EVENTS = """
Use a given PERSONALITY to write the next thing you would say in the conversation. 
- If starting the conversation, start with asking about the other person or talking about something that happened in your life recently. 
- Do not repeat information shared previously in the conversation. 
- Make the conversation personal e.g., talk about family, friends, likes, dislikes and aspirations. 
- Include references to time such as 'last Friday', 'next month' or 'when I was ten years old', and to specific people. 
- Write replies in less than 20 words. 
- Ask follow-up questions from previous conversations. 
- Find opportunities to write replies where you share a photo of things you own or like, things you need help with, or old memories, and talk about the photo to tell them more about yourself. Photos should be relevant to you. 
- When sharing a photo, write the detailed caption of the photo between square brackets. For example, "When I was a child, my mother used to bake pineapple birthday cakes and I loved them.\n[shares an old photo of a pineapple birthday cake with a candle that says 1]"

PERSONALITY: %s

%s last talked to %s on %s.

%s

Today is %s. You are %s. The following events have happened in your life since you last met this person:
%s

Use the events in your conversation. %s Write the next thing you would say in this conversation with %s according to your PERSONALITY:
"""


AGENT_CONV_PROMPT_W_EVENTS_V2_INIT = """
Use a given PERSONALITY to write the next thing you would say in the conversation.
- Write replies in less than 20 words. 
- Make the conversation deep and personal e.g., talk about emotions, likes, dislikes, aspirations and relationships. Discuss significant life-events in detail.
- Do not repeat information shared previously in the conversation. 
- Include references to time such as 'last Friday', 'next month' or 'when I was ten years old', and to specific people. 
- Sometimes, ask follow-up questions from previous conversations or current topic. 
- Find opportunities to write replies where you share a photo of things you own or like, things you need help with, or old memories, and talk about the photo to tell them more about yourself. Photos should be relevant to you. 
- When sharing a photo, write the detailed caption of the photo between square brackets. For example, "When I was a child, my mother used to bake pineapple birthday cakes and I loved them.\n[shares an old photo of a pineapple birthday cake with a candle that says 1]"
- Don't talk about outdoor activities.

PERSONALITY: %s


%s last talked to %s on %s. Today is %s. You are %s. 

This is a summary of your conversation so far.
SUMMARY:
%s

The following events have happened in your life since you last met this person:
EVENTS:
%s



%s Write the next thoughtful thing you would say in this conversation with %s. Discuss only the given EVENTS and its effect on your life in the conversation. Express distress if EVENTS are negative.:
"""


AGENT_CONV_PROMPT_W_EVENTS_V2 = """
Use a given PERSONALITY to write the next thing you would say in the conversation. 
- Write replies in less than 20 words. 
- Make the conversation deep and personal e.g., talk about emotions, likes, dislikes, aspirations and relationships. Discuss significant life-events in detail.
- Do not repeat information shared previously in the conversation. 
- Include references to time such as 'last Friday', 'next month' or 'when I was ten years old', and to specific people. 
- Sometimes, ask follow-up questions from previous conversations or current topic. 
- Find opportunities to write replies where you share a photo of things you own or like, things you need help with, or old memories, and talk about the photo to tell them more about yourself. Photos should be relevant to you. 
- When sharing a photo, write the detailed caption of the photo between square brackets. For example, "When I was a child, my mother used to bake pineapple birthday cakes and I loved them.\n[shares an old photo of a pineapple birthday cake with a candle that says 1]"
- Don't talk about outdoor activities.

PERSONALITY: %s

%s last talked to %s on %s. Today is %s. You are %s. 

This is a summary of your conversation so far.
SUMMARY:
%s

The following events have happened in your life since you last met this person:
EVENTS:
%s

The following information is known to both speakers.
RELEVANT_CONTEXT:
%s

%s Write the next thing thoughtful thing you would say in this friendly and intimate conversation with %s. Discuss only the given EVENTS and its effect on your life in the conversation. Express distress if EVENTS are negative.:
"""


ALIGNMENT_PROMPT = "Let's write whether the given image is relevant to the dialog. Indicate 1 if the image is relevant and 0 if the image is not relevant. For example,\n\nDialog: So Jeremy, how was your day? Anything interesting happen?\nImage Caption: A photo of the garden she planted and cultivated in her backyard with her daughter last year.\nOutput: 0\n\nDialog: Hey Lauri! My day was pretty good. I went to the art museum with my mentor and saw some amazing pieces. How about you? How was your day?\nImage Caption: A selfie of him and his mentor at the museum art exhibit they went to two weeks ago\nOutput: 1\n\nIndicate whether the image is relevant to the dialog for the following dialog and image caption. Output 0 or 1.\n\n"


DIALOG2IMAGE_QUERY_PROMPT = "Let's write short image search queries from textual descriptions of photos shared by a user. Queries should not include names of people, years and other irrelevant details. For example:\n\nInput: That sounds relaxing, Jeremy! As for video game suggestions, have you ever tried \"The Legend of Zelda: Breath of the Wild\"? It's an open-world adventure game that I absolutely love. [shares a photo of Link standing in front of a breathtaking landscape] Have a look at this stunning view!\nOutput: the legend of zelda: breath of wild link landscape\n\nInput: That sounds like such a special memory. Learning how to ride a bike is definitely a milestone. Do you still enjoy biking now? [shares a photo of a scenic bike trail] This is a beautiful bike trail I came across recently. It looks like a peaceful place to ride.\nOutput: scenic bike trail\n\nInput: Yes, we also visited a beautiful sunflower field in Korea. [shares a photo of a vast field of sunflowers] It was such a stunning sight with rows and rows of vibrant yellow flowers stretching as far as the eye could see. It was definitely a highlight of our trip. Have you ever seen a sunflower field before?\n Output: sunflower field korea\n\nWrite search query for the following input.\n\nInput: %s\nOutput: "

CASUAL_DIALOG_PROMPT = "Make the sentence short, less formal, less grandiose and more casual. \n\nInput: %s\nOutput: "


SESSION_SUMMARY_PROMPT = "Previous conversations between %s and %s so far can be summarized as follows: %s. The current time and date are %s. %s and %s just had the following conversation:\n\n%s\n\nSummarize the previous and current conversations between %s and %s in 150 words or less. Include key facts about both speakers and time references.\n\n"


SESSION_SUMMARY_INIT_PROMPT = "Write a concise summary containing key facts mentioned about %s and %s on %s in the following conversation:\n\n%s\n\n"


VISUAL_QUESTION_PROMPT = "{}\n\n{}\n\n{} says, {}, and {}. Write the most natural question or comment {} can include in her response."


def get_msc_persona(args):
    # check if personas exist, else generate persona + summary
    if (os.path.exists(args.agent_a_file) and os.path.exists(args.agent_b_file)) and not args.overwrite_persona:
        return None, None
    else:
        all_personas = json.load(open('./data/msc_personas_all.json'))
        selected_idx = random.choice([idx for idx, d in enumerate(all_personas['train']) if not d["in_dataset"]])
        attributes = all_personas['train'][selected_idx]
        with open('./data/msc_personas_all.json', "w") as f:
            all_personas['train'][selected_idx]["in_dataset"] = 1
            json.dump(all_personas, f, indent=2)
        agent_a = get_persona(args, attributes['Speaker 1'])

        agent_a['persona_summary'] = agent_a['persona']
        agent_a['msc_prompt'] = attributes['Speaker 1']
        agent_b = get_persona(args, attributes['Speaker 2']) # setting the second agent to have age within +/- 5 years of first agent

        agent_b['persona_summary'] = agent_b['persona']
        agent_b['msc_prompt'] = attributes['Speaker 2']
        del agent_a['persona']
        del agent_b['persona']
        print("Agent A Persona: %s" % agent_a['persona_summary'])
        print("Agent B Persona: %s" % agent_b['persona_summary'])
    return agent_a, agent_b


def get_persona(args, attributes, target='human', ref_age=None):

    task = json.load(open(os.path.join(args.prompt_dir, 'persona_generation_examples.json')))
    persona_examples = [task["input_prefix"] + json.dumps(e["input"], indent=2) + '\n' + task["output_prefix"] + e["output"] for e in task['examples']]
    input_string = task["input_prefix"] + json.dumps(attributes, indent=2)

    query = PERSONA_FROM_MSC_PROMPT % (persona_examples, input_string)

    try:
        output = run_chatgpt(query, num_gen=1, num_tokens_request=1000, use_16k=True).strip()
        output = json.loads(output)
    except:
        output = run_chatgpt(query, num_gen=1, num_tokens_request=1000, use_16k=True).strip()
        output = json.loads(output)
    
    if type(output) == list:
        output = [clean_json_output(out) for out in output]
    elif type(output) == str:
        output = clean_json_output(output)
    elif type(output) == dict:
        output = {k.lower(): v for k,v in output.items()}
        pass
    else:
        raise TypeError
    
    # print(output)

    return output


def get_datetime_string(input_time='', input_date=''):

    assert input_time or input_date

    if input_date:
        year, month, day = input_date
    if input_time:
        hour, min = input_time
        time_mod = 'am' if hour <= 12 else 'pm'
        hour = hour if hour <= 12 else hour-12
        min = str(min).zfill(2)

    if input_time and not input_date:
        return str(hour) + ':' + min + ' ' + time_mod
    elif input_date and not input_time:
        return day + ' ' + month + ', ' + year
    else:
        return str(hour) + ':' + min + ' ' + time_mod + ' on ' + day + ' ' + month + ', ' + year 


def insert_image(text, events):

    dialog = {"text": text, "raw_text": text}

    if len(events) == 0:
        return dialog
    id_2_event = {e["img_id"]: e for e in events}
    matches = re.findall(r"\[(?i)SHARES [1-9]\]", text)
    for m in matches:
        mid = int(m[-2:-1])
        dialog["text"] = dialog["text"].replace(m, '')
        
        try:
            assert mid in id_2_event, [text, m, mid]
            dialog["img_url"] = id_2_event[mid]["img_url"][0]
            dialog["img_file"] = id_2_event[mid]["img_file"][0]
            dialog["img_id"] = id_2_event[mid]["img_id"]
            dialog["image"] = id_2_event[mid]["image"]
            if "caption" in id_2_event[mid]:
                dialog["caption"] = id_2_event[mid]["caption"]

        except AssertionError:
            print("Did not find %s in events" % str(mid))
            continue

    return dialog


def get_images(query, out_dir, file_offset):
    
    google_crawler = GoogleImageCrawler(downloader_cls=CustomLinkPrinter, storage={'root_dir': out_dir})
    google_crawler.downloader.file_urls = []
    google_crawler.downloader.file_names = []
    google_crawler.crawl(keyword=query, max_num=1, file_idx_offset=file_offset, overwrite=True, filters={'type': 'photo', 'size': '=3024x4032'}) # 'license': 'commercial,modify'
    file_urls =  google_crawler.downloader.file_urls
    file_names = google_crawler.downloader.file_names

    if file_names == []:
        google_crawler = GoogleImageCrawler(downloader_cls=CustomLinkPrinter, storage={'root_dir': out_dir})
        google_crawler.downloader.file_urls = []
        google_crawler.downloader.file_names = []
        google_crawler.crawl(keyword=query, max_num=1, file_idx_offset=file_offset, overwrite=True, filters={'type': 'photo', 'size': '=4032x3024'}) # 'license': 'commercial,modify'
        file_urls =  google_crawler.downloader.file_urls
        file_names = google_crawler.downloader.file_names
    
    return file_urls, file_names


def replace_captions(text, args):

    task = json.load(open(os.path.join(args.prompt_dir, 'image_sharing_examples.json')))
    query = task['prompt']
    examples = []
    for e in task['examples']:
        examples.append([task['input_format'].format(*e["input"]), e["output"]])

    text = text.replace('[END]', '')
    matches = re.findall(r"\[.*\]", text)
    for m in matches:
        if text.replace(m ,'').isspace():
            return ""
        else:
            new_text = run_chatgpt_with_examples(query, examples, m[1:-1], num_gen=1, num_tokens_request=1000, use_16k=False)
            if len(set(text.replace(m, '').split()).intersection(new_text.split())) < 0.5 * len(set(text.replace(m, '').split())):
                text = text.replace(m, '')
            else:
                text = new_text
        break

    return text

def insert_image_response(text):

    matches = re.findall(r"\[.*\]", text)

    image_search_query = None
    m = None
    for m in matches:
        if 'share' in m or 'Share' in m:
            image_search_query = run_chatgpt(DIALOG2IMAGE_QUERY_PROMPT % text, 1, 20, 'chatgpt').strip()
            break
        else:
            text = text.replace(m, '')

    return image_search_query, m


def merge_captions(conv_dir, caption_file):

    captions = json.load(open(caption_file))
    agent_a = json.load(open(os.path.join(conv_dir, 'agent_a.json')))
    agent_b = json.load(open(os.path.join(conv_dir, 'agent_b.json')))

    for c in captions:
        head, img_file_name = os.path.split(c["img_file"])
        head, agent = os.path.split(head)
        head, session_id = os.path.split(head)
        head, conv_id = os.path.split(head)
        # print(agent, session_id, img_file_name)
        if agent == 'a':
            for i, e in enumerate(agent_a['events_%s' % session_id]):
                if e['img_file'][0] == img_file_name:
                    agent_a['events_%s' % session_id][i]["caption"] = c["summary"]
        else:
            for i, e in enumerate(agent_b['events_%s' % session_id]):
                if e['img_file'][0] == img_file_name:
                    agent_b['events_%s' % session_id][i]["caption"] = c["summary"]
    
    with open(os.path.join(conv_dir, 'agent_a_captions.json'), 'w') as f:
        json.dump(agent_a, f, indent=2)
    with open(os.path.join(conv_dir, 'agent_b_captions.json'), 'w') as f:
        json.dump(agent_b, f, indent=2)


def insert_image_in_dialog(session, agent_a_events, agent_b_events, agent_a_name, agent_b_name):

    agent_a_id_2_event = {e["img_id"]: e for e in agent_a_events}
    agent_b_id_2_event = {e["img_id"]: e for e in agent_b_events}

    for i in range(len(session)):
        text = session[i]["text"]
        matches = re.findall(r"\[shares photo [1-9]\]", text)
        for m in matches:
            mid = int(m[-2:-1])
            if session[i]["speaker"] == agent_a_name:

                session[i]["text"] = session[i]["text"].replace(m, '')
                
                if "url" not in session[i]:
                    session[i]["url"] = []
                try:
                    assert mid in agent_a_id_2_event, [text, m, mid]
                    session[i]["url"].append(agent_a_id_2_event[mid]["img_url"][0])
                except AssertionError:
                    continue

            if session[i]["speaker"] == agent_b_name:
                
                session[i]["text"] = session[i]["text"].replace(m, '')

                if "url" not in session[i]:
                    session[i]["url"] = []
                try:
                    assert mid in agent_b_id_2_event
                    session[i]["url"].append(agent_b_id_2_event[mid]["img_url"][0])
                except AssertionError:
                    continue

    return session


def clean_dialog(output, name):

    if output.startswith(name):
        output = output[len(name):]
        output = output.strip()
        if output[0] == ':':
            output = output[1:]
            output = output.strip()
    
    return output


def clean_json_output(output_string):

    print(output_string)

    output_string = output_string.strip()

    if output_string[0] == '[' and output_string[-1] != ']':
        start_index = output_string.index('[')
        end_index = output_string.rindex(']')
        output_string = output_string[start_index:end_index+1]

    if output_string[0] == '{' and output_string[-1] != '}':
        start_index = output_string.index('{')
        end_index = output_string.rindex('}')
        output_string = output_string[start_index:end_index+1]

    # balance brackets in json
    num_start_bracket = len(find_indices(output_string, '{'))
    num_end_bracket = len(find_indices(output_string, '}'))

    if num_start_bracket != num_end_bracket:
        if num_end_bracket < num_start_bracket:
            output_string = output_string + ' '.join(['}']*(num_start_bracket-num_end_bracket))
        if num_start_bracket < num_end_bracket:
            output_string = ' '.join(['{']*(num_end_bracket-num_start_bracket)) + ' ' + output_string

    # balance brackets in json
    num_start_bracket = len(find_indices(output_string, '['))
    num_end_bracket = len(find_indices(output_string, ']'))

    if num_start_bracket != num_end_bracket:
        if num_end_bracket < num_start_bracket:
            output_string = output_string + ' '.join(['[']*(num_start_bracket-num_end_bracket))
        if num_start_bracket < num_end_bracket:
            output_string = ' '.join([']']*(num_end_bracket-num_start_bracket)) + ' ' + output_string

    return json.loads(output_string)


def find_indices(list_to_check, item_to_find):
    indices = []
    for idx, value in enumerate(list_to_check):
        if value == item_to_find:
            indices.append(idx)
    return indices


class CustomLinkPrinter(ImageDownloader):
    
    file_urls = []
    file_names = []

    def get_filename(self, task, default_ext):
        file_idx = self.fetched_num + self.file_idx_offset
        file_url = task['file_url']
        # self.file_urls.append(file_url)
        return '{:04d}.{}'.format(file_idx, default_ext)

    def download(self, task, default_ext, timeout=5, max_retry=3, overwrite=False, **kwargs):
        """Download the image and save it to the corresponding path.

        Args:
            task (dict): The task dict got from ``task_queue``.
            timeout (int): Timeout of making requests for downloading images.
            max_retry (int): the max retry times if the request fails.
            **kwargs: reserved arguments for overriding.
        """
        file_url = task["file_url"]
        task["success"] = False
        task["filename"] = None
        retry = max_retry

        if not overwrite:
            with self.lock:
                self.fetched_num += 1
                filename = self.get_filename(task, default_ext)
                if self.storage.exists(filename):
                    self.logger.info("skip downloading file %s", filename)
                    return
                self.fetched_num -= 1

        while retry > 0 and not self.signal.get("reach_max_num"):
            try:
                response = self.session.get(file_url, timeout=timeout)
            except Exception as e:
                self.logger.error(
                    "Exception caught when downloading file %s, " "error: %s, remaining retry times: %d",
                    file_url,
                    e,
                    retry - 1,
                )
            else:
                if self.reach_max_num():
                    self.signal.set(reach_max_num=True)
                    break
                elif response.status_code != 200:
                    self.logger.error("Response status code %d, file %s", response.status_code, file_url)
                    break
                elif not self.keep_file(task, response, **kwargs):
                    break
                with self.lock:
                    self.fetched_num += 1
                    filename = self.get_filename(task, default_ext)
                self.logger.info("image #%s\t%s", self.fetched_num, file_url)
                self.file_urls.append(file_url)
                self.file_names.append(filename)
                self.storage.write(filename, response.content)
                task["success"] = True
                task["filename"] = filename
                break
            finally:
                retry -= 1

    # def download(self, task, default_ext, timeout=5, max_retry=3, overwrite=False, **kwargs):
    #     file_url = task['file_url']
    #     filename = self.get_filename(task, default_ext)

    #     task['success'] = True
    #     task['filename'] = filename

    #     if not self.signal.get('reach_max_num'):
    #         self.file_urls.append(file_url)
    #         self.file_names.append(filename)

    #     self.fetched_num += 1

    #     if self.reach_max_num():
    #         self.signal.set(reach_max_num=True)

    #     return
